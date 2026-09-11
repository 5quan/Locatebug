// 进度投影：从事件流"算"出一次诊断进行到哪了。
//
// 铁律：不新增状态源。进度 = f(事件)，和 replayAgentState 一样是从 RunLog 派生的投影——
// 事件流仍是唯一事实源，本文件只是另一种读法（给人看的读法，回放是给程序看的读法）。
// 因此它天然可作用于：内存中的事件流、.runs/*.jsonl 读回的事件、将来的任何持久层。

import type { AgentEvent, QueryObservation } from "./contracts.ts";
import { describeEvent } from "./core.ts";

export interface RunProgress {
  // 机器可判定的阶段：started=刚受理 investigating=查证中 reporting=交卷中
  // finished/failed/cancelled = 终态（以终态事件为准，不允许"看起来结束了"的猜测）
  phase:
    | "started"
    | "investigating"
    | "reporting"
    | "finished"
    | "failed"
    | "cancelled";
  resultStatus?: "complete" | "partial"; // phase=finished 时：报告是完整还是部分
  error?: { code: string; message: string }; // phase=failed 时

  // 过程量（全部由事件推导，无独立计数器）
  toolCallsPlanned: number; // 模型发起的工具调用次数（decision_made call_tool）
  queries: Array<{
    kind: "logs" | "code_search" | "code_read";
    target: string; // logs=服务名 / code_search=pattern / code_read=path
    status: "success" | "error";
  }>;
  evidenceCount: number; // 累计收集的证据条数

  // 时间与用量
  startedAt?: number;
  lastAt?: number;
  elapsedMs?: number; // lastAt - startedAt（run 未结束时就是"已耗时"）
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    toolCalls: number;
    durationMs: number;
    model?: string;
  };

  // 最新一步（人话；复用 core.describeEvent，保证与 demo/日志同一套说法）
  lastEvent?: { sequence: number; type: string; summary: string; timestamp: number };
}

function observationTarget(observation: QueryObservation): string {
  switch (observation.kind) {
    case "logs":
      return observation.intent.service;
    case "code_search":
      return observation.intent.pattern;
    case "code_read":
      return observation.intent.path;
  }
}

export function projectProgress(events: AgentEvent[]): RunProgress {
  const progress: RunProgress = {
    phase: "started",
    toolCallsPlanned: 0,
    queries: [],
    evidenceCount: 0,
  };

  for (const event of events) {
    progress.lastAt = event.timestamp;
    switch (event.type) {
      case "run_started":
        progress.startedAt = event.timestamp;
        break;
      case "decision_made":
        if (event.decision.kind === "call_tool") {
          progress.toolCallsPlanned++;
          progress.phase = "investigating";
        } else {
          progress.phase = "reporting";
        }
        break;
      case "observation_added": {
        progress.evidenceCount += event.observation.evidence.length;
        progress.queries.push({
          kind: event.observation.kind,
          target: observationTarget(event.observation),
          status: event.observation.status,
        });
        if (progress.phase !== "reporting") progress.phase = "investigating";
        break;
      }
      case "usage_reported":
        progress.usage = event.usage;
        break;
      case "run_completed":
        progress.phase = "finished";
        progress.resultStatus = event.status;
        break;
      case "run_failed":
        progress.phase = "failed";
        progress.error = event.error;
        break;
      case "run_cancelled":
        progress.phase = "cancelled";
        break;
      default:
        break; // tool_started/completed 不改变阶段：它们属于相邻决策与观察之间
    }
  }

  if (progress.startedAt !== undefined && progress.lastAt !== undefined) {
    progress.elapsedMs = progress.lastAt - progress.startedAt;
  }
  const last = events[events.length - 1];
  if (last) {
    progress.lastEvent = {
      sequence: last.sequence,
      type: last.type,
      summary: describeEvent(last),
      timestamp: last.timestamp,
    };
  }
  return progress;
}
