// 会话存储：JSONL 追加日志。
// 日志是唯一真源：第一行 header，之后每行一个事件。
// 消息读时派生；标题也是事件，latest-wins，列表不用读全部消息。
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./llm.ts";

const SESSIONS_DIR = ".sessions";
const SESSION_VERSION = 1;
const TITLE_MAX_LENGTH = 20;

// 第一行：会话身份证。格式升级靠 version 区分。
interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
}

// 消息事件：seq 由存储层连续分配，time 是写入时间。
interface MessageEvent {
  type: "message";
  seq: number;
  time: number;
  message: ChatMessage;
}

// 标题事件：日志里的一行，但不派生为 messages（模型看不到它）。
interface TitleEvent {
  type: "title";
  seq: number;
  time: number;
  title: string;
}

// 权限模式：现在只定义词汇和事件格式，权限执行还没接线。
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export const SANDBOX_MODES: readonly SandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

// 权限事件：latest-wins。读日志时 fold 出当前模式。
interface SandboxModeEvent {
  type: "sandbox/mode";
  seq: number;
  time: number;
  mode: SandboxMode;
}

type FileEvent = SessionHeader | MessageEvent | TitleEvent | SandboxModeEvent;
type BodyEvent = MessageEvent | TitleEvent | SandboxModeEvent;

// 一次完整 replay 的结果：从流水账 fold 出的全部当前状态。
export interface SessionState {
  messages: ChatMessage[];
  title?: string;
  sandboxMode?: SandboxMode;
}

// 当前进程内每个会话"下一条该写几号"。load/create 会填好，
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

// 追加一条标题事件。标题只在首轮提问时追加一次。
export async function appendTitle(id: string, fromMessage: string): Promise<void> {
  const title = makeTitle(fromMessage);
  if (!title) return;

  const seq = await nextSeq(id);
  const event: TitleEvent = {
    type: "title",
    seq,
    time: Date.now(),
    title,
  };

  await appendFile(sessionFile(id), JSON.stringify(event) + "\n", "utf-8");
  nextSeqById.set(id, seq + 1);
}

// 追加一条权限模式事件。这是"记录事实"，不是执行权限；
// 真正限制 read/write/edit 的代码以后读 SessionState.sandboxMode 再判断。
export async function appendSandboxMode(id: string, mode: SandboxMode): Promise<void> {
  if (!SANDBOX_MODES.includes(mode)) {
    throw new Error(`非法 sandbox 模式：${String(mode)}`);
  }

  const seq = await nextSeq(id);
  const event: SandboxModeEvent = {
    type: "sandbox/mode",
    seq,
    time: Date.now(),
    mode,
  };

  await appendFile(sessionFile(id), JSON.stringify(event) + "\n", "utf-8");
  nextSeqById.set(id, seq + 1);
}

// 唯一的读取入口：读文件、校验 header、重放所有事件。
// 调用方从这里一次拿到 messages / title / sandboxMode，不再各自读文件。
export async function readSession(id: string): Promise<SessionState> {
  const events = parseLines(await readSessionText(id));

  const first = events[0];
  if (first === undefined || first.type !== "session") {
    throw new Error(`会话文件损坏：缺少 session header（${id}）`);
  }
  const header = first;
  if (header.id !== id) {
    throw new Error(`会话文件损坏：header id 与文件名不一致（${header.id} != ${id}）`);
  }
  if (header.version !== SESSION_VERSION) {
    throw new Error(`不支持的会话版本：${header.version}`);
  }

  const state = replaySession(events.slice(1) as BodyEvent[]);
  nextSeqById.set(id, events.length - 1);
  return state;
}

// 列出所有会话。标题来自 readSession fold 出的 state。
export async function listSessions(): Promise<Array<{ id: string; title: string }>> {
  const ids = await listSessionIds();
  const sessions = await Promise.all(
    ids.map(async (id) => ({ id, title: (await readSession(id)).title ?? "(空会话)" })),
  );
  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

// 下一条事件的编号。有缓存用缓存；没有则重读文件算出来。
async function nextSeq(id: string): Promise<number> {
  const cached = nextSeqById.get(id);
  if (cached !== undefined) return cached;

  const events = parseLines(await readSessionText(id));
  if (events[0]?.type !== "session") {
    throw new Error(`会话文件损坏：缺少 session header（${id}）`);
  }
  return events.length - 1;
}

// fold：把流水账从头到尾重放一遍，一次算出全部当前状态。
//   message       → push 进 messages
//   title         → 覆盖 title（latest-wins）
//   sandbox/mode  → 覆盖 sandboxMode（latest-wins）
// 同时校验 seq 必须 0,1,2... 连续。
function replaySession(events: BodyEvent[]): SessionState {
  const state: SessionState = {
    messages: [],
    title: undefined,
    sandboxMode: undefined,
  };
  let expectedSeq = 0;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new Error(`日志编号不连续：期望 ${expectedSeq}，实际 ${String(event.seq)}`);
    }
    expectedSeq++;

    switch (event.type) {
      case "message":
        state.messages.push(event.message);
        break;
      case "title":
        state.title = event.title;
        break;
      case "sandbox/mode":
        state.sandboxMode = event.mode;
        break;
    }
  }

  return state;
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

// 标题文本：压成一行，去首尾空格，最长 20 字。
function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > TITLE_MAX_LENGTH
    ? oneLine.slice(0, TITLE_MAX_LENGTH) + "…"
    : oneLine;
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

// 所有 id 都会拼进文件路径，先做白名单校验，防止 --session ../xxx 之类跑出 .sessions/。
function sessionFile(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`非法会话 id：${id}`);
  }
  return join(SESSIONS_DIR, `${id}.jsonl`);
}


