// 阶段 3：RunLog —— 事件落库（skill「Storage contracts」）。
//
// 设计要点：
// - append-only JSONL 是唯一事实源，快照只是缓存（本项目 v1 连快照都没有）；
// - 一个 run 一个文件（.runs/<runId>.jsonl），并发 run 天然隔离；
// - 首行是 header（记录 task），后续每行一个 AgentEvent；
// - startRun 用 wx 独占创建：同一 ticketId 并发提交/重启后重复提交，只有一次能建成文件
//   ——幂等不是"查一下有没有"，是原子的 claim；
// - appendEvent 内部按 run 串行化写队列：调用方可以 fire-and-forget，行与行不会交叉。

import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent, TicketTask } from "./contracts.ts";

export interface RunSummary {
  runId: string;
  ticketId: string;
  requestKey?: string;
  createdAt: number;
  terminal?: AgentEvent; // 已落库的终态事件（可能有：run 还在进行中）
}

export type ClaimOutcome =
  | { granted: true }
  | { granted: false; runId: string }; // 已被同 (ticketId, requestKey) 的运行占住

export interface RunLog {
  /** 独占创建一个 run 的日志文件并写入 header；文件已存在（重复提交）时抛 EEXIST */
  startRun(runId: string, task: TicketTask, requestKey?: string): Promise<void>;
  /**
   * 原子幂等 claim：同一 (ticketId, requestKey) 只有一个运行能成功。
   * claim 文件用 wx 独占创建 = 原子操作，并发/重启下都不会双跑。
   */
  claimTicket(ticketId: string, requestKey: string, runId: string): Promise<ClaimOutcome>;
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: string): Promise<AgentEvent[]>;
  readTask(runId: string): Promise<TicketTask | undefined>;
  listRuns(): Promise<RunSummary[]>;
}

interface RunHeader {
  header: true;
  runId: string;
  ticketId: string;
  requestKey?: string;
  task: TicketTask;
  createdAt: number;
}

interface ClaimRecord {
  ticketId: string;
  requestKey: string;
  runId: string;
  createdAt: number;
}

function isHeader(line: unknown): line is RunHeader {
  return typeof line === "object" && line !== null && (line as RunHeader).header === true;
}

export class JsonlRunLog implements RunLog {
  private readonly dir: string;
  // 每个 run 一条写队列：appendEvent 可以被并发调用，但落盘顺序与调用顺序一致
  private readonly writeQueues = new Map<string, Promise<void>>();

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(dir: string) {
    this.dir = dir;
  }

  private fileOf(runId: string): string {
    // runId 由 Runtime 生成；防御性过滤路径分隔符
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`非法 runId：${runId}`);
    return join(this.dir, `${runId}.jsonl`);
  }

  private static sanitizeId(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  }

  private claimFileOf(ticketId: string, requestKey: string): string {
    // 同一 (ticketId, requestKey) 唯一对应一个 claim 文件；哈希后缀避免清洗后的键互相碰撞
    const digest = createHash("sha256").update(requestKey).digest("hex").slice(0, 12);
    return join(this.dir, ".claims", `${JsonlRunLog.sanitizeId(ticketId)}__${digest}.json`);
  }

  async startRun(runId: string, task: TicketTask, requestKey?: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const header: RunHeader = {
      header: true,
      runId,
      ticketId: task.ticketId,
      task,
      createdAt: Date.now(),
      ...(requestKey ? { requestKey } : {}),
    };
    const handle = await open(this.fileOf(runId), "wx"); // 独占创建 = 原子幂等 claim
    try {
      await handle.writeFile(JSON.stringify(header) + "\n", "utf8");
    } finally {
      await handle.close();
    }
  }

  async claimTicket(ticketId: string, requestKey: string, runId: string): Promise<ClaimOutcome> {
    const file = this.claimFileOf(ticketId, requestKey);
    await mkdir(join(this.dir, ".claims"), { recursive: true });
    const record: ClaimRecord = { ticketId, requestKey, runId, createdAt: Date.now() };
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
      } finally {
        await handle.close();
      }
      return { granted: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // 已有同键 claim：把已有 runId 告诉调用方，它能据此查询原运行
      let existing: ClaimRecord | undefined;
      try {
        existing = JSON.parse(await readFile(file, "utf8")) as ClaimRecord;
      } catch {
        // claim 文件残缺：保守起见按"被占住"处理，runId 给本次的（查询会 404，但不会双跑）
      }
      return { granted: false, runId: existing?.runId ?? runId };
    }
  }

  appendEvent(event: AgentEvent): Promise<void> {
    const previous = this.writeQueues.get(event.runId) ?? Promise.resolve();
    const next = previous.then(() =>
      appendFile(this.fileOf(event.runId), JSON.stringify(event) + "\n", "utf8"),
    );
    // 单次写失败不断裂队列；失败本身随 next 抛给调用方决定怎么处理
    this.writeQueues.set(event.runId, next.catch(() => {}));
    return next;
  }

  private async readLines(runId: string): Promise<unknown[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileOf(runId), "utf8");
    } catch {
      return [];
    }
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined; // 残缺行跳过：写进程崩溃可能留下半行
        }
      })
      .filter((line): line is unknown => line !== undefined);
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    const lines = await this.readLines(runId);
    return lines.filter((line): line is AgentEvent => !isHeader(line));
  }

  async readTask(runId: string): Promise<TicketTask | undefined> {
    const lines = await this.readLines(runId);
    const header = lines.find(isHeader);
    return header?.task;
  }

  async listRuns(): Promise<RunSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const summaries: RunSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
      const runId = name.slice(0, -".jsonl".length);
      const lines = await this.readLines(runId);
      const header = lines.find(isHeader);
      const events = lines.filter((line): line is AgentEvent => !isHeader(line));
      summaries.push({
        runId,
        ticketId: header?.ticketId ?? "?",
        createdAt: header?.createdAt ?? 0,
        terminal: events.findLast?.((e) =>
          ["run_completed", "run_failed", "run_cancelled"].includes(e.type),
        ),
        ...(header?.requestKey ? { requestKey: header.requestKey } : {}),
      });
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }
}
