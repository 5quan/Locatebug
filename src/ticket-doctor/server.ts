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
import type { TicketTask } from "./contracts.ts";
import { GitCodeSource } from "./code-sources.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { FileLogSource } from "./log-sources.ts";
import { PiDiagnosisEngine } from "./pi-adapter.ts";
import { JsonlRunLog } from "./run-log.ts";
import { TicketDoctorRuntime } from "./runtime.ts";

const PORT = Number(process.env.PORT ?? 7777);
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_DIR = join(PROJECT_ROOT, ".runs");
const SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

const logSource = new FileLogSource(SAMPLES_DIR);
const engine =
  process.env.DOCTOR_ENGINE === "fake"
    ? new FakeDiagnosisEngine({ logSource })
    : new PiDiagnosisEngine({
        logSource,
        // 工单带 commit 才启用代码工具，且版本钉死在该 commit 上（"提测信息包含代码版本"）
        codeSource: (task) =>
          task.commit ? new GitCodeSource(PROJECT_ROOT, { commit: task.commit }) : undefined,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: process.env.DEEPSEEK_API_KEY,
      });
const runtime = new TicketDoctorRuntime({
  engine,
  runLog: new JsonlRunLog(RUNS_DIR),
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
  return {
    ticketId: body.ticketId as string,
    title: body.title as string,
    description: body.description as string,
    ...(typeof body.service === "string" ? { service: body.service } : {}),
    ...(typeof body.occurredAt === "number" ? { occurredAt: body.occurredAt } : {}),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)(\/events|\/comment|\/progress)?$/.exec(url.pathname);

  try {
    // ---- 提交工单（webhook 语义：立即受理，后台诊断）----
    if (req.method === "POST" && url.pathname === "/api/tickets") {
      const task = validateTicket(JSON.parse(await readBody(req)));
      const result = await runtime.submit(task);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `ticket-doctor server listening on http://127.0.0.1:${PORT} ` +
      `(engine=${process.env.DOCTOR_ENGINE === "fake" ? "fake" : "pi/deepseek-v4-flash"}, runs=${RUNS_DIR})`,
  );
});
