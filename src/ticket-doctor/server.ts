// 阶段 3：HTTP 触发服务 —— 模拟云效工单 webhook 的接入面。
//
// 启动：npm run doctor:server        （真实引擎，每单约 5K tokens）
//       DOCTOR_ENGINE=fake npm run doctor:server   （假引擎，零成本调试）
//
// 接口：
//   POST /api/tickets              提交工单（body=TicketTask JSON），202 表示已受理，重复工单返回 accepted=false
//   GET  /api/runs                 列出所有诊断 run 与终态
//   GET  /api/runs/:id/events      某次诊断的完整事件流（审计/回放）
//   GET  /api/runs/:id/comment     该工单应写回的备注文本（无报告时返回说明）
//
// 配置：
//   DOCTOR_REPOS={"app":"D:\\repo\\backend","frontend":"D:\\repo\\web"}
//       业务仓库映射（repoId → 目录）。工单的 commit / repositories 按它解析成完整 SHA。
//   DOCTOR_SKILLS_DIR / DOCTOR_SKILL_ID
//       Skill 目录与显式指定；缺省读项目 skills/ 目录。
//
// 注意：无鉴权、只绑定本地——这是阶段 3 的开发接入面；鉴权与真实云效对接在阶段 4。

import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeEvent,
  extractReport,
  renderTicketComment,
  replayAgentState,
} from "./core.ts";
import { projectProgress } from "./progress.ts";
import type { RepoBinding, RunContext, TicketTask } from "./contracts.ts";
import { GitCodeSource, MultiRepoCodeSource, resolveRepoSha } from "./code-sources.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { FileLogSource } from "./log-sources.ts";
import { PiDiagnosisEngine } from "./pi-adapter.ts";
import { JsonlRunLog } from "./run-log.ts";
import { SkillRegistry } from "./skill-registry.ts";
import { TicketDoctorRuntime } from "./runtime.ts";

const PORT = Number(process.env.PORT ?? 7777);
// 默认只绑本机（无鉴权面不外暴）；容器/反向代理部署时用 HOST=0.0.0.0
const HOST = process.env.HOST ?? "127.0.0.1";
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_DIR = join(PROJECT_ROOT, ".runs");
const SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));
const SKILLS_DIR = process.env.DOCTOR_SKILLS_DIR ?? join(PROJECT_ROOT, "skills");

// 业务仓库映射：repoId → 仓库目录。缺省只有一个"本仓库"（样例演示用）。
function loadRepoConfig(): Record<string, string> {
  const raw = process.env.DOCTOR_REPOS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const repos: Record<string, string> = {};
      for (const [repoId, dir] of Object.entries(parsed)) {
        if (typeof dir === "string" && dir) repos[repoId] = dir;
      }
      if (Object.keys(repos).length > 0) return repos;
    } catch {
      console.error("DOCTOR_REPOS 不是合法 JSON，回退默认仓库配置");
    }
  }
  return { app: PROJECT_ROOT };
}

const repoConfig = loadRepoConfig();
const logSource = new FileLogSource(SAMPLES_DIR);
const skillRegistry = new SkillRegistry(SKILLS_DIR);

// 运行开始时把工单里的版本引用解析成完整 SHA（前后端分仓逐仓解析、逐仓记录），
// 并固定本次使用的 Skill 版本。解析失败 = 受理失败（fail fast，不烧模型调用）。
async function prepareContext(task: TicketTask): Promise<Partial<RunContext>> {
  const repos: RepoBinding[] = [];
  const wanted =
    task.repositories && task.repositories.length > 0
      ? task.repositories
      : task.commit
        ? [{ repoId: "app", rev: task.commit }]
        : [];
  for (const ref of wanted) {
    const dir = repoConfig[ref.repoId];
    if (!dir) {
      throw new Error(
        `仓库 ${ref.repoId} 未在 DOCTOR_REPOS 中配置（可用：${Object.keys(repoConfig).join(", ")}）`,
      );
    }
    const rev = ref.rev ?? "HEAD";
    const sha = await resolveRepoSha(dir, rev);
    repos.push({ repoId: ref.repoId, rev, sha });
  }
  const skill = await skillRegistry.select(process.env.DOCTOR_SKILL_ID);
  return {
    ...(repos.length > 0 ? { repos } : {}),
    ...(task.environmentId ? { environmentId: task.environmentId } : {}),
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

const engine =
  process.env.DOCTOR_ENGINE === "fake"
    ? new FakeDiagnosisEngine({ logSource })
    : new PiDiagnosisEngine({
        logSource,
        // 运行上下文里已有解析好的完整 SHA，这里按仓构造只读代码源（版本在 prepareContext 钉死）
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
          if (sources.length === 1) return sources[0];
          return new MultiRepoCodeSource(sources);
        },
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: process.env.DEEPSEEK_API_KEY,
      });
const runtime = new TicketDoctorRuntime({
  engine,
  runLog: new JsonlRunLog(RUNS_DIR),
  prepareContext,
});

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validateTicket(raw: unknown): TicketTask {
  const body = raw as Record<string, unknown>;
  for (const field of ["ticketId", "title", "description"] as const) {
    if (typeof body?.[field] !== "string" || (body[field] as string).length === 0) {
      throw new Error(`字段 ${field} 必须是非空字符串`);
    }
  }
  if (/\.[\\/]|\.\./.test(body.ticketId as string)) throw new Error("ticketId 含非法字符");
  const task: TicketTask = {
    ticketId: body.ticketId as string,
    title: body.title as string,
    description: body.description as string,
  };
  // 可选字段逐个透传（此前 commit 在这里被丢弃，HTTP 提交永远开不了代码工具）
  if (typeof body.service === "string" && body.service) task.service = body.service;
  if (typeof body.occurredAt === "number") task.occurredAt = body.occurredAt;
  if (typeof body.commit === "string" && body.commit) task.commit = body.commit;
  if (typeof body.entryUrl === "string" && body.entryUrl) task.entryUrl = body.entryUrl;
  if (typeof body.expectedBehavior === "string" && body.expectedBehavior) {
    task.expectedBehavior = body.expectedBehavior;
  }
  if (typeof body.actualBehavior === "string" && body.actualBehavior) {
    task.actualBehavior = body.actualBehavior;
  }
  if (typeof body.environmentId === "string" && body.environmentId) {
    task.environmentId = body.environmentId;
  }
  if (Array.isArray(body.reproductionSteps)) {
    const steps = body.reproductionSteps
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, 50);
    if (steps.length > 0) task.reproductionSteps = steps;
  }
  if (Array.isArray(body.repositories)) {
    const repos = body.repositories
      .filter(
        (r): r is { repoId: string; rev?: string } =>
          typeof r === "object" && r !== null &&
          typeof (r as { repoId?: unknown }).repoId === "string" &&
          (r as { repoId: string }).repoId.length > 0,
      )
      .slice(0, 10)
      .map((r) => (typeof r.rev === "string" && r.rev ? { repoId: r.repoId, rev: r.rev } : { repoId: r.repoId }));
    if (repos.length > 0) task.repositories = repos;
  }
  return task;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)(\/events|\/comment|\/progress)?$/.exec(url.pathname);

  try {
    // ---- 提交工单（webhook 语义：立即受理，后台诊断）----
    if (req.method === "POST" && url.pathname === "/api/tickets") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const task = validateTicket(body);
      // requestKey 幂等身份：调用方可显式指定；缺省 = 工单内容的稳定哈希（重投 → duplicate）
      const requestKey = typeof body.requestKey === "string" && body.requestKey ? body.requestKey : undefined;
      const result = await runtime.submit(task, requestKey ? { requestKey } : {});
      sendJson(res, result.accepted ? 202 : 200, result);
      return;
    }

    // ---- 列出 runs ----
    if (req.method === "GET" && url.pathname === "/api/runs") {
      sendJson(res, 200, await runtime.listRuns());
      return;
    }

    // ---- 单个 run：事件流 / 备注预览 ----
    if (req.method === "GET" && runMatch) {
      const [, runId, action] = runMatch;
      const events = await runtime.getEvents(runId);
      if (events.length === 0) {
        sendJson(res, 404, { error: `run 不存在：${runId}` });
        return;
      }
      if (action === "/events" || action === undefined) {
        sendJson(res, 200, events);
        return;
      }
      // /progress：从事件日志投影出进度视图（不新增状态源，进度 = f(事件)）
      if (action === "/progress") {
        sendJson(res, 200, projectProgress(events));
        return;
      }
      // /comment：从事件日志回放出报告，渲染成工单备注
      const task = await runtime.getTask(runId);
      if (!task) {
        sendJson(res, 500, { error: "run 文件缺少 header（task）" });
        return;
      }
      const report = extractReport(events);
      if (!report) {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        res.end("诊断尚未产出报告（进行中或失败）。用 /events 查看进展。");
        return;
      }
      const comment = renderTicketComment(task, report);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(comment);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `ticket-doctor server listening on http://${HOST}:${PORT} ` +
      `(engine=${process.env.DOCTOR_ENGINE === "fake" ? "fake" : "pi/deepseek-v4-flash"}, runs=${RUNS_DIR})`,
  );
});
