// 进度投影测试：进度 = f(事件)，从事件流确定性推导，不依赖任何运行时状态。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, TicketTask } from "./contracts.ts";
import { projectProgress } from "./progress.ts";

const TASK: TicketTask = {
  ticketId: "BUG-P1",
  title: "进度投影测试",
  description: "d",
  service: "checkout-service",
};

const T = Date.parse("2026-09-06T10:00:00+08:00");
let seq = 0;
const at = () => T + (seq += 1000); // 每个事件间隔 1 秒，elapsed 可断言

function queryLogsObservation(service: string, status: "success" | "error", evidenceCount = 1) {
  return {
    kind: "logs" as const,
    intent: { service, timeWindow: { from: 0, to: 1 }, keywords: [] },
    status,
    evidence: Array.from({ length: evidenceCount }, (_, i) => ({
      source: `s#${i}`,
      time: T,
      level: "ERROR",
      excerpt: `e${i}`,
    })),
  };
}

function build(
  tools: Array<{ name: string; status: "success" | "error" }>,
  terminal?: "complete" | "partial" | "failed" | "cancelled",
): AgentEvent[] {
  const events: AgentEvent[] = [
    { type: "run_started", runId: "run_BUG-P1", sequence: ++seq, timestamp: at() },
  ];
  for (const tool of tools) {
    events.push({
      type: "decision_made",
      runId: "run_BUG-P1",
      sequence: ++seq,
      timestamp: at(),
      decision: {
        kind: "call_tool",
        name: tool.name as "query_logs",
        arguments: { service: "checkout-service", timeWindow: { from: 0, to: 1 }, keywords: [] },
      },
    });
    events.push({
      type: "observation_added",
      runId: "run_BUG-P1",
      sequence: ++seq,
      timestamp: at(),
      name: tool.name,
      observation: queryLogsObservation("checkout-service", tool.status, 2),
    });
  }
  // 终态只在显式要求时追加：进行中场景的事件流本来就没有终态
  if (terminal === "complete" || terminal === "partial") {
    events.push({
      type: "run_completed",
      runId: "run_BUG-P1",
      sequence: ++seq,
      timestamp: at(),
      status: terminal,
      result: { status: terminal, hypotheses: [], suggestedNextSteps: [] },
    });
  } else if (terminal === "failed") {
    events.push({
      type: "run_failed",
      runId: "run_BUG-P1",
      sequence: ++seq,
      timestamp: at(),
      error: { code: "budget_timeout", message: "超时" },
    });
  } else if (terminal === "cancelled") {
    events.push({ type: "run_cancelled", runId: "run_BUG-P1", sequence: ++seq, timestamp: at() });
  }
  return events;
}

test("只有 run_started：phase=started，过程量全零", () => {
  seq = 0;
  const p = projectProgress(build([]));
  assert.equal(p.phase, "started");
  assert.equal(p.toolCallsPlanned, 0);
  assert.equal(p.evidenceCount, 0);
  assert.equal(p.elapsedMs, 0); // 单事件：startedAt === lastAt
});

test("查证中：phase=investigating，queries 聚合了每次查询的目标与状态", () => {
  seq = 0;
  const p = projectProgress(
    build([
      { name: "query_logs", status: "success" },
      { name: "query_logs", status: "error" },
    ]),
  );
  assert.equal(p.phase, "investigating");
  assert.equal(p.toolCallsPlanned, 2);
  assert.equal(p.queries.length, 2);
  assert.deepEqual(
    p.queries.map((q) => [q.kind, q.target, q.status]),
    [
      ["logs", "checkout-service", "success"],
      ["logs", "checkout-service", "error"],
    ],
  );
  assert.equal(p.evidenceCount, 4); // 2 次观察 × 每次 2 条证据
});

test("交卷中：respond 决策后 phase=reporting，直到终态", () => {
  seq = 0;
  const events = build([]); // 无终态
  events.push({
    type: "decision_made",
    runId: "run_BUG-P1",
    sequence: ++seq,
    timestamp: at(),
    decision: {
      kind: "respond",
      report: { status: "complete", hypotheses: [], suggestedNextSteps: [] },
    },
  });
  const mid = projectProgress(events); // 没有终态事件：应在 reporting
  assert.equal(mid.phase, "reporting");

  events.push({
    type: "run_completed",
    runId: "run_BUG-P1",
    sequence: ++seq,
    timestamp: at(),
    status: "complete",
    result: { status: "complete", hypotheses: [], suggestedNextSteps: [] },
  });
  const done = projectProgress(events);
  assert.equal(done.phase, "finished");
  assert.equal(done.resultStatus, "complete");
});

test("终态：partial/failed/cancelled 各自映射到正确 phase 与附属信息", () => {
  seq = 0;
  const partial = projectProgress(build([{ name: "query_logs", status: "success" }], "partial"));
  assert.equal(partial.phase, "finished");
  assert.equal(partial.resultStatus, "partial");

  seq = 0;
  const failed = projectProgress(build([], "failed"));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error?.code, "budget_timeout");

  seq = 0;
  const cancelled = projectProgress(build([], "cancelled"));
  assert.equal(cancelled.phase, "cancelled");
});

test("elapsedMs 与 usage：从事件时间戳与 usage_reported 推导", () => {
  seq = 0;
  const events = build([{ name: "query_logs", status: "success" }]);
  events.push({
    type: "usage_reported",
    runId: "run_BUG-P1",
    sequence: ++seq,
    timestamp: at(),
    usage: { inputTokens: 100, outputTokens: 5, toolCalls: 1, durationMs: 3000, model: "m" },
  });
  const p = projectProgress(events);
  assert.equal(p.usage?.inputTokens, 100);
  assert.ok((p.elapsedMs ?? 0) >= 3000, "4 个事件 × 1 秒间隔");
  assert.ok(p.lastEvent?.summary.includes("usage_reported"));
});
