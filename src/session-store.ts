// 会话存储：JSONL 追加日志 + header + 事件编号。
// 日志是唯一真源；读会话时逐行"重放"，并由存储层校验 seq 连续性。
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./llm.ts";

const SESSIONS_DIR = ".sessions";
const SESSION_VERSION = 1;

// 第一行：会话身份证。以后格式升级靠 version 区分。
interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
}

// 之后每行一个事件。seq 由存储层连续分配；time 是写入时间。
// seq/time 设为可选，是为了兼容还没有这两字段的旧日志。
interface MessageEvent {
  type: "message";
  seq?: number;
  time?: number;
  message: ChatMessage;
}

type FileEvent = SessionHeader | MessageEvent;

// 当前进程内每个会话"下一条该写几号"。load/create 时会填好，
// 避免每次追加都重读文件；进程重启后 load 会重新算。
const nextSeqById = new Map<string, number>();

// 新建会话：写 header 行，返回 id。
export async function createSession(): Promise<string> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const id = randomUUID();

  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt: Date.now(),
  };

  // "wx"：文件已存在就报错，绝不覆盖旧会话。
  await writeFile(sessionFile(id), JSON.stringify(header) + "\n", { flag: "wx" });
  nextSeqById.set(id, 0);
  return id;
}

// 追加一条消息。seq/time 在这里分配，调用方只给消息内容。
export async function appendMessage(id: string, msg: ChatMessage): Promise<void> {
  const seq = await nextSeq(id);
  const event: MessageEvent = {
    type: "message",
    seq,
    time: Date.now(),
    message: msg,
  };

  await appendFile(sessionFile(id), JSON.stringify(event) + "\n", "utf-8");
  nextSeqById.set(id, seq + 1);
}

// 读取日志并派生 messages。system 不在这里；调用方每次运行时自己注入最前面。
export async function loadSession(id: string): Promise<ChatMessage[]> {
  const events = parseLines(await readSessionText(id));

  // 有 header：校验身份证和版本；没有 header：按旧版日志兼容读取。
  const hasHeader = events[0]?.type === "session";
  let body: MessageEvent[];

  if (hasHeader) {
    const header = events[0] as SessionHeader;
    if (header.id !== id) {
      throw new Error(`会话文件损坏：header id 与文件名不一致（${header.id} != ${id}）`);
    }
    if (header.version !== SESSION_VERSION) {
      throw new Error(`不支持的会话版本：${header.version}`);
    }
    body = events.slice(1) as MessageEvent[];
  } else {
    body = events as MessageEvent[];
  }

  const messages = deriveMessages(body, hasHeader);
  nextSeqById.set(id, body.length);
  return messages;
}

// 列出所有会话。标题取首条 user 消息前 20 字。
export async function listSessions(): Promise<Array<{ id: string; title: string }>> {
  const ids = await listSessionIds();
  const sessions = await Promise.all(
    ids.map(async (id) => ({ id, title: await titleFor(id) })),
  );
  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

// 下一条事件的编号。有缓存用缓存；没有则重读文件算出来。
async function nextSeq(id: string): Promise<number> {
  const cached = nextSeqById.get(id);
  if (cached !== undefined) return cached;

  const events = parseLines(await readSessionText(id));
  const body = events[0]?.type === "session"
    ? (events.slice(1) as MessageEvent[])
    : (events as MessageEvent[]);
  return body.length;
}

// 日志行 -> 消息。新格式校验 seq 必须 0,1,2... 连续；旧格式按行序直接派生。
function deriveMessages(events: MessageEvent[], checkSeq: boolean): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let expectedSeq = 0;

  for (const event of events) {
    if (checkSeq) {
      if (typeof event.seq !== "number" || event.seq !== expectedSeq) {
        throw new Error(`日志编号不连续：期望 ${expectedSeq}，实际 ${String(event.seq)}`);
      }
      expectedSeq++;
    }

    if (event.type === "message") {
      messages.push(event.message);
    }
  }

  return messages;
}

// 读取文本并把每行解析成事件。空行跳过。
function parseLines(text: string): FileEvent[] {
  const events: FileEvent[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    events.push(JSON.parse(trimmed) as FileEvent);
  }

  return events;
}

async function readSessionText(id: string): Promise<string> {
  try {
    return await readFile(sessionFile(id), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`会话不存在：${id}`);
    }
    throw error;
  }
}

// 找 .sessions/ 下所有 .jsonl 文件名；目录不存在时视为"还没有会话"。
async function listSessionIds(): Promise<string[]> {
  try {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -".jsonl".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// 标题：找第一条 user 消息，压成一行，取前 20 字。
async function titleFor(id: string): Promise<string> {
  const messages = await loadSession(id);
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "(空会话)";

  const oneLine = firstUser.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 20 ? oneLine.slice(0, 20) + "…" : oneLine;
}

// 所有 id 都会拼进文件路径，先做白名单校验，防止 --session ../xxx 之类跑出 .sessions/。
function sessionFile(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`非法会话 id：${id}`);
  }
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

