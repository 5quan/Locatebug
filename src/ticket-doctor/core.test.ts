// 阶段 1 的 Core 语义测试（skill：每个退出标准都要对应一个跑过的测试）。
// 全程使用假引擎 + 内存日志源：确定性、无网络、无 SDK。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRunInvariants,
  extractReport,
  replayAgentState,
  renderTicketComment,
  terminalEvent,
} from "./core.ts";
import type { AgentEvent, LogEntry, LogSource, TicketTask } from "./contracts.ts";
import { FakeDiagnosisEngine, type FakeModelScript } from "./fake-engine.ts";

const T0 = Date.parse("2026-09-06T10:02:00+08:00");

const TICKET: TicketTask = {
  ticketId: "BUG-1024",
  title: "下单接口批量 500",
  description: "2026-09-06 10:02 起下单接口大量 500，正常下单即可复现。",
  service: "checkout-service",
  occurredAt: T0,
};

// 内存日志源：不碰文件系统，测试完全确定
function memoryLogSource(entries: LogEntry[], name = "memory-log-source"): LogSource {
  return { name, query: async () => entries };
}

const LOG_ENTRIES: LogEntry[] = [
  {
    time: T0 - 61_000,
    level: "WARN",
    message: "RedisPool 获取连接超时(2000ms) pool=checkout-cache",
  },
  {
    time: T0 - 2_000,
    level: "ERROR",
    message: "InventoryClient 调用库存服务失败 timeout after 3000ms traceId=tr_9f2c81",
  },
  {
    time: T0 - 1_000,
    level: "ERROR",
    message: "OrderService 创建订单失败 NullPointerException OrderService.java:88 traceId=tr_9f2c81",
  },
];

async function runOnce(
  task: TicketTask,
  logSource: LogSource,
  script?: FakeModelScript,
  maxIterations?: number,
): Promise<AgentEvent[]> {
  const engine = new FakeDiagnosisEngine({ logSource, script, maxIterations });
  const events: AgentEvent[] = [];
  for await (const event of engine.run(task, AbortSignal.timeout(5_000))) {
    events.push(event);
  }
  return events;
}

test("完整路径：查询到错误日志 → complete 报告，事件流自洽", async () => {
  const events = await runOnce(TICKET, memoryLogSource(LOG_ENTRIES));

  // 事件顺序即 skill 的最小循环：决策 → 工具 → 观察 → 报告
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "run_started",
      "decision_made",
      "tool_started",
      "tool_completed",
      "observation_added",
      "decision_made",
      "usage_reported",
      "run_completed",
    ],
  );
  assertRunInvariants(events); // sequence 单调 + 终态唯一且在最后

  const firstDecision = events[1];
  assert(firstDecision.type === "decision_made");
  assert.equal(firstDecision.decision.kind, "call_tool");

  const report = extractReport(events);
  assert(report, "run_completed 应携带报告");
  assert.equal(report.status, "complete");
  assert.equal(report.hypotheses.length, 1);

  const evidence = report.hypotheses[0].evidence;
  assert.equal(evidence.length, 2); // 只有 2 条 ERROR 进假设，WARN 不参与归因
  for (const ev of evidence) {
    assert(ev.source.includes("memory-log-source"), "证据必须带 provenance");
    assert(ev.excerpt.length > 0);
  }
});

test("查询失败 → partial 报告 + missingMaterial，绝不用 run_failed 交差", async () => {
  const events = await runOnce(TICKET, {
    name: "broken-log-source",
    query: async () => {
      throw new Error("日志平台 503");
    },
  });

  // 关键语义：日志平台挂了 ≠ 运行失败。运行正常终止，产出的是 partial 报告，
  // 这样开发至少能在工单上看到"AI 想查什么、为什么没查成"。
  const terminal = terminalEvent(events);
  assert(terminal?.type === "run_completed", "工具失败不是 run 失败：仍应产出 partial 报告");
  assert.equal(terminal.status, "partial");
  assert.equal(terminal.missingMaterial?.length, 1);
  assert(terminal.missingMaterial![0].includes("日志平台 503"));

  const report = extractReport(events);
  assert.equal(report?.status, "partial");
  assert.equal(report?.hypotheses.length, 0);

  const comment = renderTicketComment(TICKET, report!);
  assert(comment.includes("部分结果"));
  assert(comment.includes("缺失材料"));
});

test("空转守卫：连续两轮完全相同的查询 → no_progress", async () => {
  const spin: FakeModelScript = () => ({
    kind: "call_tool",
    name: "query_logs",
    arguments: {
      service: "checkout-service",
      timeWindow: { from: 0, to: T0 + 1 },
      keywords: ["ERROR"],
    },
  });
  // 预算给 5 轮：证明守卫在预算耗尽之前就先拦住了空转
  const events = await runOnce(TICKET, memoryLogSource(LOG_ENTRIES), spin, 5);

  const terminal = terminalEvent(events);
  assert(terminal?.type === "run_failed");
  assert.equal(terminal.error.code, "no_progress");
  assert(!extractReport(events), "run_failed 没有报告可提取");
});

test("迭代预算：maxIterations 轮内不产出报告 → budget_iterations", async () => {
  // 关键词每轮变化，绕开空转守卫，专测迭代预算
  const script: FakeModelScript = (state) => ({
    kind: "call_tool",
    name: "query_logs",
    arguments: {
      service: "checkout-service",
      timeWindow: { from: 0, to: T0 + 1 },
      keywords: [`kw-${state.iteration}`],
    },
  });
  const events = await runOnce(TICKET, memoryLogSource(LOG_ENTRIES), script, 2);

  const terminal = terminalEvent(events);
  assert(terminal?.type === "run_failed");
  assert.equal(terminal.error.code, "budget_iterations");
});

test("回放：从事件日志重建的状态与运行时一致", async () => {
  const events = await runOnce(TICKET, memoryLogSource(LOG_ENTRIES));
  const { state, terminal } = replayAgentState(events, TICKET);

  assert.equal(state.observations.length, 1); // 1 次 observation_added
  assert.equal(state.iterations, 1);
  assert.equal(state.observations[0].evidence.length, 3);
  assert(terminal?.type === "run_completed");
});

test("不变量校验：非单调 sequence / 终态之后还有事件 都会被拒绝", async () => {
  const events = await runOnce(TICKET, memoryLogSource(LOG_ENTRIES));
  assertRunInvariants(events); // 正常事件流必须通过

  assert.throws(
    () => assertRunInvariants([events[0], { ...events[1], sequence: events[0].sequence }]),
    "seq 相同的两条事件必须被拒绝",
  );

  const afterTerminal = {
    type: "observation_added",
    runId: "run_x",
    sequence: events[events.length - 1].sequence + 1,
    timestamp: 1,
    name: "query_logs",
    observation: {
      kind: "logs",
      intent: { service: "s", timeWindow: { from: 0, to: 1 }, keywords: [] },
      status: "success",
      evidence: [],
    },
  } as AgentEvent;
  assert.throws(() => assertRunInvariants([...events, afterTerminal]));
});
