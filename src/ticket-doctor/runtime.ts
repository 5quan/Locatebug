// 阶段 3：Runtime —— 工单诊断的正式执行层（skill「Runtime loop」）。
//
// 职责边界：
// - 身份分离：ticketId（业务身份）/ requestKey（同一次提交的幂等身份）/ runId（每次实际执行）。
//   runId 由 Runtime 生成并传给引擎，引擎不得自行计算——同一张工单做新旧 Skill 对照评测
//   的前提就是"同 ticketId、不同 requestKey → 两次独立运行"。
// - 幂等：claim 靠 RunLog.claimTicket 的独占创建（原子）；同 (ticketId, requestKey) 重复提交
//   返回 duplicate + 原 runId，不会双跑。
// - 落库：引擎产出的每个事件，经过 Runtime 时同步写入 RunLog（写队列内部串行）；
// - 预算：Runtime 拥有并组合终止信号（调用方 signal + 超时），Engine 只服从；
// - 可预测终止：引擎结束却没有终态事件 / 引擎抛异常，Runtime 都会补一条 run_failed 落库；
//   运行期间持有保活句柄，防止事件循环提前排空导致"挂着的 run 永远到不了终态"。
//
// 两种消费方式（skill：live stream 单消费者，旁路消费者从 RunLog 回放）：
// - submit(task)：webhook 语义，立即返回，后台执行，事件只进 RunLog；
// - waitUntilDone(runId)：测试/同步等待用。

import { createHash, randomBytes } from "node:crypto";
import type { AgentEvent, DiagnosisEngine, RunContext, TicketTask } from "./contracts.ts";
import { isTerminalEvent } from "./core.ts";
import type { RunLog } from "./run-log.ts";

export interface RuntimeOptions {
  engine: DiagnosisEngine;
  runLog: RunLog;
  timeoutMs?: number; // 默认 180_000：比引擎内置 120s 宽，作为 Runtime 侧的最终预算
  /**
   * 运行开始前的上下文准备（解析源码完整 SHA、选定 Skill 版本等）。
   * 抛错 = 受理失败（fail fast：坏 commit 不该烧掉一次模型调用）。
   */
  prepareContext?: (task: TicketTask) => Promise<Partial<RunContext>>;
}

export interface SubmitOptions {
  requestKey?: string; // 缺省 = 工单业务内容的稳定哈希（webhook 重投 → duplicate）
  callerSignal?: AbortSignal;
}

export interface SubmitResult {
  runId: string;
  accepted: boolean;
  reason?: "duplicate"; // accepted=false 时：同 (ticketId, requestKey) 已经诊断过（或正在进行）
}

function sanitizeRunIdPart(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

/** requestKey 缺省值：工单业务内容的稳定哈希（同内容重投 = 幂等，改版重提 = 新运行）。 */
export function defaultRequestKey(task: TicketTask): string {
  const canonical = JSON.stringify({
    ticketId: task.ticketId,
    title: task.title,
    description: task.description,
    service: task.service ?? null,
    occurredAt: task.occurredAt ?? null,
    commit: task.commit ?? null,
    entryUrl: task.entryUrl ?? null,
    expectedBehavior: task.expectedBehavior ?? null,
    actualBehavior: task.actualBehavior ?? null,
    reproductionSteps: task.reproductionSteps ?? null,
    environmentId: task.environmentId ?? null,
    repositories: task.repositories ?? null,
  });
  return `req_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

export class TicketDoctorRuntime {
  private readonly engine: DiagnosisEngine;
  private readonly runLog: RunLog;
  private readonly timeoutMs: number;
  private readonly prepareContext?: (task: TicketTask) => Promise<Partial<RunContext>>;
  private readonly inflight = new Map<string, Promise<void>>();
  private keepAlive?: NodeJS.Timeout;

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(opts: RuntimeOptions) {
    this.engine = opts.engine;
    this.runLog = opts.runLog;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.prepareContext = opts.prepareContext;
  }

  /** runId 每次执行都新生成：`run_<ticketId>_<时间36进制>_<随机4>`，文件名安全。 */
  newRunId(task: TicketTask): string {
    const time = Date.now().toString(36);
    const rand = randomBytes(2).toString("hex");
    return `run_${sanitizeRunIdPart(task.ticketId)}_${time}_${rand}`;
  }

  async submit(task: TicketTask, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const requestKey = opts.requestKey ?? defaultRequestKey(task);
    const runId = this.newRunId(task);

    // 原子 claim：同 (ticketId, requestKey) 只有一次能成功；重投返回原 runId
    const claim = await this.runLog.claimTicket(task.ticketId, requestKey, runId);
    if (!claim.granted) {
      return { runId: claim.runId, accepted: false, reason: "duplicate" };
    }

    // 上下文准备失败 = 受理失败（fail fast）。claim 已占用：重投同一 requestKey 会拿到
    // duplicate + 一个不存在的 runId——宁可如此也不能烧模型调用，属可接受的失败语义。
    let extras: Partial<RunContext> = {};
    if (this.prepareContext) {
      try {
        extras = await this.prepareContext(task);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`运行上下文准备失败：${message}`);
      }
    }

    try {
      await this.runLog.startRun(runId, task, requestKey); // 独占创建事件日志
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        return { runId, accepted: false, reason: "duplicate" };
      }
      throw err;
    }

    const context: RunContext = {
      runId,
      ticketId: task.ticketId,
      requestKey,
      ...extras,
    };

    const done = this.execute(task, context, opts.callerSignal).finally(() => {
      this.inflight.delete(runId);
      if (this.inflight.size === 0) this.releaseKeepAlive();
    });
    this.inflight.set(runId, done);
    this.holdKeepAlive();
    return { runId, accepted: true };
  }

  // 等某个 run 结束（测试用；服务端不需要——它读 RunLog）
  waitUntilDone(runId: string): Promise<void> {
    return this.inflight.get(runId) ?? Promise.resolve();
  }

  // ---- RunLog 的只读委托：server / 阶段 4 的写回适配器从这里取数，不碰存储细节 ----

  listRuns() {
    return this.runLog.listRuns();
  }

  getEvents(runId: string) {
    return this.runLog.listEvents(runId);
  }

  getTask(runId: string) {
    return this.runLog.readTask(runId);
  }

  /**
   * 运行期间的保活句柄：AbortSignal.timeout 的计时器是 unref 的，如果 run 是进程里
   * 唯一的事，事件循环会提前排空，挂死的引擎永远等不到超时兜底（测试环境真实踩过）。
   */
  private holdKeepAlive(): void {
    if (!this.keepAlive) {
      this.keepAlive = setInterval(() => {}, 1 << 30);
    }
    this.keepAlive.ref?.();
  }

  private releaseKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
  }

  private async execute(task: TicketTask, context: RunContext, callerSignal?: AbortSignal): Promise<void> {
    const runId = context.runId;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let timedOut = false;
    timeoutSignal.addEventListener("abort", () => {
      timedOut = true;
    }, { once: true });
    const composed = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    try {
      for await (const event of this.engine.run(task, composed, context)) {
        await this.runLog.appendEvent(event); // 引擎每吐一个，Runtime 落一个
      }
      // 无终态守卫：引擎正常结束却没给终态 = 引擎违约，Runtime 补一条可审计的失败
      const events = await this.runLog.listEvents(runId);
      const last = events[events.length - 1];
      if (!last || !isTerminalEvent(last)) {
        await this.runLog.appendEvent(this.synthFailed(runId, events, timedOut, "引擎结束但未产生终态事件"));
      }
    } catch (err) {
      // 引擎抛异常（不该发生，但必须留痕）：补 run_failed，sequence 接着已落库的排
      const events = await this.runLog.listEvents(runId).catch(() => [] as AgentEvent[]);
      const message = err instanceof Error ? err.message : String(err);
      await this.runLog
        .appendEvent(this.synthFailed(runId, events, timedOut, `引擎异常：${message}`))
        .catch(() => {}); // 落库失败也不能掩盖原始异常已经发生过的事实
    }
  }

  private synthFailed(
    runId: string,
    events: AgentEvent[],
    timedOut: boolean,
    message: string,
  ): AgentEvent {
    return {
      type: "run_failed",
      runId,
      sequence: (events[events.length - 1]?.sequence ?? 0) + 1,
      timestamp: Date.now(),
      error: {
        code: timedOut ? "budget_timeout" : "runtime_error",
        message: timedOut ? `诊断超过 Runtime 时间预算 ${this.timeoutMs}ms` : message,
      },
    };
  }
}
