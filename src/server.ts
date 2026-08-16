// 原生 Node HTTP server：无状态 API + 单文件前端页面。
// 状态都在 .sessions/*.jsonl 里；server 只是"壳"。
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { createSession, listSessions, readSession } from "./session-store.ts";
import { runUserTurn } from "./turn.ts";

const PORT = Number(process.env.PORT ?? 3000);
const INDEX_HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));

// 当前最简单的并发控制：同一会话同时只允许一个 run。
// 不是锁，只是让前端等待；多用户/多 worker 阶段再换真队列。
const runningSessions = new Set<string>();

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    console.error("请求处理失败：", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.end();
    }
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  // ---- 会话列表 / 新建会话 ----
  if (url.pathname === "/api/sessions") {
    if (method === "GET") {
      return sendJson(res, 200, { sessions: await listSessions() });
    }
    if (method === "POST") {
      const id = await createSession();
      return sendJson(res, 201, { id });
    }
  }

  // ---- 读取 / 追加一个会话的消息 ----
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (match) {
    const id = decodeURIComponent(match[1]);

    if (method === "GET") {
      const state = await readSession(id);
      return sendJson(res, 200, {
        id,
        title: state.title ?? "(空会话)",
        messages: state.messages,
        sandboxMode: state.sandboxMode ?? "workspace-write",
      });
    }

    if (method === "POST") {
      if (runningSessions.has(id)) {
        return sendJson(res, 409, { error: "这个会话正在处理中，请稍候" });
      }

      const body = await readJson(req);
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) {
        return sendJson(res, 400, { error: "content 不能为空" });
      }

      runningSessions.add(id);
      try {
        const result = await runUserTurn(id, content);
        return sendJson(res, 200, result);
      } finally {
        runningSessions.delete(id);
      }
    }
  }

  // ---- 前端页面 ----
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(INDEX_HTML, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  sendJson(res, 404, { error: `未找到：${method} ${url.pathname}` });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) {
      throw new Error("请求体超过 1MB");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`pi-demo 已启动：http://localhost:${PORT}`);
});
