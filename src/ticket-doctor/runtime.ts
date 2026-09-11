// 阶段 3：Runtime —— 工单诊断的正式执行层（skill「Runtime loop」）。
//
// 职责边界：
// - 幂等：ticketId → runId（run_<ticketId>），claim 靠 RunLog.startRun 的独占创建；
// - 落库：引擎产出的每个事件，经过 Runtime 时同步写入 RunLog（写队列内部串行）；
// - 预算：Runtime 拥有并组合终止信号（调用方 signal + 超时），Engine 只服从；
// - 可预测终止：引擎结束却没有终态事件 / 引擎抛异常，Runtime 都会补一条 run_failed 落库
//   —— "一次 run 必须可预测地终止，否则它不配叫 Runtime"（skill）。
//
// 两种消费方式（skill：live stream 单消费者，旁路消费者从 RunLog 回放）：
// - submit(task)：webhook 语义，立即返回，后台执行，事件只进 RunLog；
// - waitUntilDone(runId)：测试/同步等待用。

import type { AgentEvent, DiagnosisEngine, TicketTask } from "./contracts.ts";
import { isTerminalEvent } from "./core.ts";
import type { RunLog } from "./run-log.ts";

export interface RuntimeOptions {
  engine: DiagnosisEngine;
  runLog: RunLog;
  timeoutMs?: number; // 默认 180_000：比引擎内置 120s 宽，作为 Runtime 侧的最终预算
}

export interface SubmitResult {
  runId: string;
  accepted: boolean;
  reason?: "duplicate"; // accepted=false 时：该工单已经诊断过（或正在进行）
}

export class TicketDoctorRuntime {
  private readonly engine: DiagnosisEngine;
  private readonly runLog: RunLog;
  private readonly timeoutMs: number;
  private readonly inflight = new Map<string, Promise<void>>();

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(opts: RuntimeOptions) {
    this.engine = opts.engine;
    this.runLog = opts.runLog;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  // runId 由 ticketId 确定性导出：同一工单无论提交几次，claim 的都是同一个文件
  runIdOf(task: TicketTask): string {
    return `run_${task.ticketId}`;
  }

  async submit(task: TicketTask, callerSignal?: AbortSignal): Promise<SubmitResult> {
    const runId = this.runIdOf(task);
    try {
      await this.runLog.startRun(runId, task); // 原子 claim：并发/重启下也只有一个能成功
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        return { runId, accepted: false, reason: "duplicate" };
      }
      throw err;
    }
    const done = this.execute(runId, task, callerSignal).finally(() => {
      this.inflight.delete(runId);
    });
    this.inflight.set(runId, done);
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

  private async execute(runId: string, task: TicketTask, callerSignal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let timedOut = false;
    timeoutSignal.addEventListener("abort", () => {
      timedOut = true;
    }, { once: true });
    const composed = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    try {
      for await (const event of this.engine.run(task, composed)) {
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
