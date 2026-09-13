// 阶段 1 的"假诊断引擎"：不接 SDK、不接网络，用一段脚本化的"模型"驱动最小循环。
//
// 它存在的意义（对应 skill 的 Development sequence 第 1-2 步）：
//   1. 在真实模型接入之前，把本产品的事件语义、complete/partial 语义、预算与空转守卫全部钉死；
//   2. 作为 DiagnosisEngine 端口的第一个实现，阶段 2 的 Pi SDK 适配器必须产出语义一致的事件流，
//      golden transcript 对比才有锚点。
//
// 事件顺序遵循 skill 的 Runtime loop：
//   run_started → decision_made → tool_started → tool_completed → observation_added
//   → （respond 时）usage_reported → run_completed/failed/cancelled
// usage_reported 固定在终态事件之前——skill 规定"usage 在终止时上报"。

import type {
  AgentEvent,
  Decision,
  Evidence,
  LogQueryIntent,
  QueryObservation,
  LogSource,
  RunContext,
  TicketTask,
} from "./contracts.ts";
import { MAX_EXCERPT_CHARS } from "./limits.ts";

// 假"模型"每次迭代看到的状态与它要做的决策。
// 真实模型接入后，这个角色由 Pi SDK 的 session.prompt + 事件归一化承担。
export type FakeModelScript = (state: FakeLoopState) => Decision;

export interface FakeLoopState {
  task: TicketTask;
  observations: QueryObservation[];
  iteration: number; // 从 1 开始
}

export interface FakeDiagnosisOptions {
  logSource: LogSource;
  script?: FakeModelScript; // 缺省用 defaultScript；测试用自定义脚本来触发各种边界
  maxIterations?: number; // 默认 3：防止"模型"无限调工具
  maxExcerptChars?: number; // 默认 200：工具结果按不可信输入处理，进证据前先截断
}

// ---------- 默认脚本：一个"诚实但只会摘日志"的分析师 ----------
//
// 行为设计成确定性的，并且处处诚实：
//   - 查询失败 → partial + missingMaterial，绝不假装成功；
//   - 查到了日志但没抓到 ERROR → complete，但明确说"没发现明显错误"；
//   - 只做确定性摘取，不做真实归因 → 置信度永远标 low。
export const defaultScript: FakeModelScript = (state) => {
  const { task, observations } = state;
  const firstQuery: LogQueryIntent = {
    service: task.service ?? "unknown",
    timeWindow: task.occurredAt
      ? { from: task.occurredAt - 10 * 60_000, to: task.occurredAt + 10 * 60_000 }
      : { from: 0, to: Number.MAX_SAFE_INTEGER },
    keywords: ["ERROR", "Exception", "timeout", "超时"],
  };

  // 还没有任何观察：先查一次日志。假模型不重试——重试策略是阶段 2 真实模型/提示词的事。
  if (observations.length === 0) {
    return { kind: "call_tool", name: "query_logs", arguments: firstQuery };
  }

  const last = observations[observations.length - 1];
  if (last.status === "error") {
    return {
      kind: "respond",
      report: {
        status: "partial",
        hypotheses: [],
        suggestedNextSteps: [
          "人工登录日志平台确认服务名与时间窗是否正确",
          "确认诊断服务的日志平台查询凭证是否有效",
        ],
        missingMaterial: [
          `${firstQuery.service} 在指定时间窗内的错误日志（查询失败：${last.error ?? "未知原因"}）`,
        ],
      },
    };
  }

  const errorEvidence = last.evidence.filter((e) => e.level === "ERROR" || e.level === "FATAL");
  if (errorEvidence.length === 0) {
    return {
      kind: "respond",
      report: {
        status: "complete",
        hypotheses: [],
        suggestedNextSteps: [
          "指定时间窗内未发现错误级别日志，请先确认工单的发生时间与所属服务是否准确",
        ],
      },
    };
  }

  return {
    kind: "respond",
    report: {
      status: "complete",
      hypotheses: [
        {
          cause: `时间窗内捕获到 ${errorEvidence.length} 条错误日志，最早的一条最可疑（假引擎只做确定性摘取，不做真实归因）`,
          confidence: "low",
          evidence: errorEvidence.slice(0, 3),
          status: "candidate", // 只摘日志不归因 → 按契约只能算候选原因
          pendingChecks: ["按证据中的 traceId 做全链路确认", "浏览器/接口复现以确认因果关系"],
        },
      ],
      suggestedNextSteps: [
        "按证据中的 traceId 在全链路追踪中查看同一请求的跨服务行为",
        `核对 ${firstQuery.service} 在时间窗附近的发布与配置变更记录`,
        "按工单复现步骤重放一次请求，确认是否稳定复现",
      ],
    },
  };
};

export class FakeDiagnosisEngine {
  private readonly opts: FakeDiagnosisOptions;

  // 注意：不用 constructor 参数属性语法（constructor(private opts)），
  // Node 的原生类型剥离不支持需要转换的 TS 语法，参数属性会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  constructor(opts: FakeDiagnosisOptions) {
    this.opts = opts;
  }

  async *run(task: TicketTask, signal: AbortSignal, context: RunContext): AsyncGenerator<AgentEvent> {
    // runId 由 Runtime 生成并传入（引擎不得自行计算；评测对照的前提）
    const runId = context.runId;
    const script = this.opts.script ?? defaultScript;
    const maxIterations = this.opts.maxIterations ?? 3;
    const maxExcerptChars = this.opts.maxExcerptChars ?? MAX_EXCERPT_CHARS;
    const logSource = this.opts.logSource;

    let seq = 0;
    let toolCalls = 0;
    const startedAt = Date.now();
    const now = () => Date.now();
    const usage = () => ({
      toolCalls,
      durationMs: now() - startedAt,
      model: "fake-scripted-model" as const,
    });

    yield { type: "run_started", runId, sequence: ++seq, timestamp: now() };

    // Skill 版本由调用方在运行开始时固定；假引擎同样如实记录（事件语义与真引擎一致）
    if (context.skill) {
      yield {
        type: "skill_selected",
        runId,
        sequence: ++seq,
        skill: context.skill,
        timestamp: now(),
      };
    }

    const observations: QueryObservation[] = [];
    let prevProgressKey: string | null = null;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (signal.aborted) {
        yield { type: "usage_reported", runId, sequence: ++seq, timestamp: now(), usage: usage() };
        yield { type: "run_cancelled", runId, sequence: ++seq, timestamp: now() };
        return;
      }

      const decision = script({ task, observations, iteration });
      yield { type: "decision_made", runId, sequence: ++seq, timestamp: now(), decision };

      if (decision.kind === "respond") {
        yield { type: "usage_reported", runId, sequence: ++seq, timestamp: now(), usage: usage() };
        yield {
          type: "run_completed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          status: decision.report.status,
          result: decision.report,
          ...(decision.report.status === "partial"
            ? { missingMaterial: decision.report.missingMaterial }
            : {}),
        };
        return;
      }

      if (decision.kind !== "call_tool" || decision.name !== "query_logs") {
        // 假引擎只实现了日志查询；脚本不会返回代码工具，这里是类型收窄 + 诚实兜底
        yield { type: "usage_reported", runId, sequence: ++seq, timestamp: now(), usage: usage() };
        yield {
          type: "run_failed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          error: {
            code: "runtime_error",
            message:
              decision.kind === "call_tool"
                ? `假引擎不支持工具 ${decision.name}`
                : "假引擎产出未知决策",
          },
        };
        return;
      }
      const intent = decision.arguments;

      // ---- call_tool：执行日志查询，把结果转成带 provenance 的证据 ----
      const toolCallId = `tc_${runId}_${iteration}`;
      const toolStartedAt = now();
      yield {
        type: "tool_started",
        runId,
        sequence: ++seq,
        timestamp: now(),
        toolCallId,
        toolName: decision.name,
      };

      let observation: QueryObservation;
      try {
        const entries = await logSource.query(intent, signal);
        const provenance = `${logSource.name} | keywords=[${intent.keywords.join(",")}] | window=[${new Date(intent.timeWindow.from).toISOString()} ~ ${new Date(intent.timeWindow.to).toISOString()}]`;
        const evidence: Evidence[] = entries.map((e) => ({
          source: provenance,
          time: e.time,
          level: e.level,
          excerpt:
            e.message.length > maxExcerptChars
              ? e.message.slice(0, maxExcerptChars) + "…"
              : e.message,
        }));
        observation = { kind: "logs", intent, status: "success", evidence };
        yield {
          type: "tool_completed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          toolCallId,
          toolName: decision.name,
          status: "success",
          result: { entries: entries.length },
          durationMs: now() - toolStartedAt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        observation = { kind: "logs", intent, status: "error", evidence: [], error: message };
        yield {
          type: "tool_completed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          toolCallId,
          toolName: decision.name,
          status: "error",
          error: { code: "log_source_unavailable", message },
          durationMs: now() - toolStartedAt,
        };
      }
      toolCalls++;

      observations.push(observation);
      yield {
        type: "observation_added",
        runId,
        sequence: ++seq,
        timestamp: now(),
        name: decision.name,
        observation,
      };

      // 空转守卫（skill 规定必须存在）：这一轮与上一轮进展完全相同（同样的查询、同样的结果）
      // = 原地打转。判定键包含意图 + 状态 + 结果数量，重复查询或重复失败都会命中。
      const progressKey = JSON.stringify({
        intent: observation.intent,
        status: observation.status,
        count: observation.evidence.length,
        error: observation.error ?? null,
      });
      if (progressKey === prevProgressKey) {
        yield { type: "usage_reported", runId, sequence: ++seq, timestamp: now(), usage: usage() };
        yield {
          type: "run_failed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          error: {
            code: "no_progress",
            message: `第 ${iteration} 轮与前一轮进展完全相同（疑似空转），按 no_progress 终止`,
          },
        };
        return;
      }
      prevProgressKey = progressKey;
    }

    yield { type: "usage_reported", runId, sequence: ++seq, timestamp: now(), usage: usage() };
    yield {
      type: "run_failed",
      runId,
      sequence: ++seq,
      timestamp: now(),
      error: {
        code: "budget_iterations",
        message: `达到最大迭代数 ${maxIterations} 仍未产出诊断报告`,
      },
    };
  }
}
