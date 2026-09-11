// 阶段 3 的 Runtime 语义测试（skill 退出清单的机器可查形式）：
//   - 幂等：同一 ticketId 只诊断一次（并发提交 + 重启后重复提交）
//   - 落库：事件按序持久化，可回放重建状态
//   - 留痕：引擎异常 / 无终态，Runtime 补 run_failed 落库
//   - 可预测终止：超时兜底
// 运行：npm test（与 core.test.ts 一起跑）

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent, DiagnosisEngine, TicketTask } from "./contracts.ts";
import { isTerminalEvent, replayAgentState } from "./core.ts";
import { JsonlRunLog } from "./run-log.ts";
import { TicketDoctorRuntime } from "./runtime.ts";

const TASK: TicketTask = {
  ticketId: "BUG-3001",
  title: "测试工单",
  description: "runtime 测试",
  service: "checkout-service",
  occurredAt: Date.parse("2026-09-06T10:02:00+08:00"),
};

// 引擎桩：按脚本吐事件，数调用次数——Runtime 测试不该碰真引擎
function scriptedEngine(
  script: (task: TicketTask) => AgentEvent[],
  counter: { calls: number },
): DiagnosisEngine {
  return {
    run: async function* (task, signal) {
      counter.calls++;
      for (const event of script(task)) {
        if (signal?.aborted) return;
        yield event;
      }
    },
  };
}

// 事件工厂：sequence 自动递增
function makeEvents(runId: string): AgentEvent[] {
  let seq = 0;
  const step = () => ++seq;
  return [
    { type: "run_started", runId, sequence: step(), timestamp: Date.now() },
    {
      type: "decision_made",
      runId,
      sequence: step(),
      timestamp: Date.now(),
      decision: {
        kind: "call_tool",
        name: "query_logs",
        arguments: { service: "s", timeWindow: { from: 0, to: 1 }, keywords: [] },
      },
    },
    {
      type: "run_completed",
      runId,
      sequence: step(),
      timestamp: Date.now(),
      status: "complete",
      result: { status: "complete", hypotheses: [], suggestedNextSteps: [] },
    },
  ];
}

async function makeRuntime(
  engine: DiagnosisEngine,
): Promise<{ runtime: TicketDoctorRuntime; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-runs-"));
  return { runtime: new TicketDoctorRuntime({ engine, runLog: new JsonlRunLog(dir) }), dir };
}

test("幂等：同一工单提交两次，引擎只跑一次，事件完整落库", async () => {
  const counter = { calls: 0 };
  const { runtime } = await makeRuntime(scriptedEngine(() => makeEvents("run_BUG-3001"), counter));

  const first = await runtime.submit(TASK);
  assert.equal(first.accepted, true);
  await runtime.waitUntilDone(first.runId);

  const second = await runtime.submit(TASK);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(counter.calls, 1, "重复提交不得触发第二次诊断");

  const events = await runtime.getEvents(first.runId);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "run_started");
  assert(isTerminalEvent(events[events.length - 1]), "最后一条必须是终态");

  const { state } = replayAgentState(events, TASK); // 落库的事件可回放
  assert.equal(state.iterations, 0); // 桩脚本没有 observation_added
});

test("重启后幂等：新 Runtime 实例指向同一目录，重复提交被拒", async () => {
  const counter = { calls: 0 };
  const dir = await mkdtemp(join(tmpdir(), "doctor-runs-"));
  const firstRuntime = new TicketDoctorRuntime({
    engine: scriptedEngine(() => makeEvents("run_BUG-3001"), counter),
    runLog: new JsonlRunLog(dir),
  });
  const first = await firstRuntime.submit(TASK);
  await firstRuntime.waitUntilDone(first.runId);

  // 模拟进程重启：全新的 Runtime + RunLog，同一磁盘目录
  const secondRuntime = new TicketDoctorRuntime({
    engine: scriptedEngine(() => makeEvents("run_BUG-3001"), counter),
    runLog: new JsonlRunLog(dir),
  });
  const again = await secondRuntime.submit(TASK);
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "duplicate");
  assert.equal(counter.calls, 1, "重启后重复提交也不得重跑");
});

test("留痕：引擎中途抛异常，Runtime 补 run_failed 落库且为最后事件", async () => {
  const counter = { calls: 0 };
  const dir = await mkdtemp(join(tmpdir(), "doctor-runs-"));
  const runtime = new TicketDoctorRuntime({
    // 先吐 2 条事件再爆炸：专门测 sequence 接排
    engine: {
      run: async function* (task) {
        counter.calls++;
        const events = makeEvents(`run_${task.ticketId}`);
        yield events[0];
        yield events[1];
        throw new Error("引擎爆炸");
      },
    },
    runLog: new JsonlRunLog(dir),
  });
  const result = await runtime.submit(TASK);
  await runtime.waitUntilDone(result.runId);

  const events = await runtime.getEvents(result.runId);
  const last = events[events.length - 1];
  assert.equal(last.type, "run_failed");
  if (last.type === "run_failed") {
    assert.equal(last.error.code, "runtime_error");
    assert.ok(last.error.message.includes("引擎爆炸"));
    assert.equal(last.sequence, 3, "sequence 接着已落库的事件排（2+1）");
  }
  assert.equal(events.length, 3, "前 2 条已落库的事件不受引擎爆炸影响");
});

test("无终态守卫：引擎正常结束却没给终态，Runtime 补 run_failed", async () => {
  const counter = { calls: 0 };
  const { runtime } = await makeRuntime(
    scriptedEngine((task) => makeEvents(`run_${task.ticketId}`).slice(0, 2), counter),
  );
  const result = await runtime.submit(TASK);
  await runtime.waitUntilDone(result.runId);

  const events = await runtime.getEvents(result.runId);
  const last = events[events.length - 1];
  assert.equal(last.type, "run_failed");
  if (last.type === "run_failed") {
    assert.ok(last.error.message.includes("未产生终态"));
  }
});

test("可预测终止：引擎挂死不理会信号，Runtime 超时补 budget_timeout", async () => {
  const counter = { calls: 0 };
  const dir = await mkdtemp(join(tmpdir(), "doctor-runs-"));
  const runtime = new TicketDoctorRuntime({
    engine: {
      run: async function* (task, signal) {
        counter.calls++;
        // 挂死：只在收到 abort 后抛错退出
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield* makeEvents(`run_${task.ticketId}`);
      },
    },
    runLog: new JsonlRunLog(dir),
    timeoutMs: 80, // 80ms 就超时
  });

  const result = await runtime.submit(TASK);
  await runtime.waitUntilDone(result.runId);

  const events = await runtime.getEvents(result.runId);
  const last = events[events.length - 1];
  assert.equal(last.type, "run_failed");
  if (last.type === "run_failed") {
    assert.equal(last.error.code, "budget_timeout");
  }
});
