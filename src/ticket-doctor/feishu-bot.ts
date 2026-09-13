// 本地飞书长连接机器人入口。
// 飞书后台选择“使用长连接接收事件”，无需公网回调地址。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { RepoBinding, RunContext, TicketTask } from "./contracts.ts";
import { GitCodeSource, MultiRepoCodeSource, resolveRepoSha } from "./code-sources.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { FeishuTicketBridge, type FeishuMessenger } from "./feishu-adapter.ts";
import { FileLogSource } from "./log-sources.ts";
import { PiDiagnosisEngine } from "./pi-adapter.ts";
import { JsonlRunLog } from "./run-log.ts";
import { SkillRegistry } from "./skill-registry.ts";
import { TicketDoctorRuntime } from "./runtime.ts";

function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

class LarkMessenger implements FeishuMessenger {
  private readonly client: Lark.Client;

  constructor(client: Lark.Client) {
    this.client = client;
  }

  async replyText(messageId: string, text: string): Promise<void> {
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书回复失败：code=${response.code}, msg=${response.msg ?? "unknown"}`);
    }
  }
}

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
loadDotEnv(join(PROJECT_ROOT, ".env"));

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请通过环境变量或项目根目录 .env 提供。");
  process.exit(1);
}

const logDir = process.env.DOCTOR_LOG_DIR ?? join(PROJECT_ROOT, "samples");
const repoDir = process.env.DOCTOR_REPO_DIR ?? PROJECT_ROOT;
const repoConfig: Record<string, string> = { app: repoDir };
const logSource = new FileLogSource(logDir);
const skillRegistry = new SkillRegistry(
  process.env.DOCTOR_SKILLS_DIR ?? join(PROJECT_ROOT, "skills"),
);

// 与 server.ts 一致：运行开始时把 commit 解析成完整 SHA 并固定 Skill 版本
async function prepareContext(task: TicketTask): Promise<Partial<RunContext>> {
  const repos: RepoBinding[] = [];
  for (const ref of task.repositories ?? (task.commit ? [{ repoId: "app", rev: task.commit }] : [])) {
    const dir = repoConfig[ref.repoId];
    if (!dir) continue; // 飞书自由文本场景只有一个业务仓，未配置的仓库跳过（缺材料走 partial 路径）
    const rev = ref.rev ?? "HEAD";
    repos.push({ repoId: ref.repoId, rev, sha: await resolveRepoSha(dir, rev) });
  }
  const skill = await skillRegistry.select(process.env.DOCTOR_SKILL_ID);
  return {
    ...(repos.length > 0 ? { repos } : {}),
    ...(skill
      ? {
          skill: {
            id: skill.id,
            version: skill.version,
            contentHash: skill.contentHash,
            source: skill.sourceDir,
          },
        }
      : {}),
  };
}

const engine = process.env.DOCTOR_ENGINE === "fake"
  ? new FakeDiagnosisEngine({ logSource })
  : new PiDiagnosisEngine({
      logSource,
      codeSource: async (_task, context) => {
        if (!context.repos || context.repos.length === 0) return undefined;
        const sources = [];
        for (const binding of context.repos) {
          const dir = repoConfig[binding.repoId];
          if (!dir) continue;
          sources.push(
            await GitCodeSource.create(dir, { commit: binding.sha, repoId: binding.repoId }),
          );
        }
        if (sources.length === 0) return undefined;
        return sources.length === 1 ? sources[0] : new MultiRepoCodeSource(sources);
      },
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });

const runtime = new TicketDoctorRuntime({
  engine,
  runLog: new JsonlRunLog(join(PROJECT_ROOT, ".runs")),
  prepareContext,
});
const client = new Lark.Client({ appId, appSecret });
const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
  autoReconnect: true,
  handshakeTimeoutMs: 15_000,
  onReady: () => console.log("飞书长连接已建立，等待群聊 @机器人 消息。"),
  onError: (err) => console.error("飞书长连接失败：", err),
});
const bridge = new FeishuTicketBridge(runtime, new LarkMessenger(client));
const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (event) => {
    try {
      const result = await bridge.handle(event);
      if (result.kind !== "ignored") console.log(`[feishu] ${result.kind} runId=${result.runId}`);
    } catch (err) {
      console.error("飞书消息受理失败：", err);
      throw err;
    }
  },
});

const stop = (): void => {
  wsClient.close({ force: true });
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await wsClient.start({ eventDispatcher: dispatcher });
