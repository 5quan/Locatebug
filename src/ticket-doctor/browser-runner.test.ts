// BrowserRunner 测试：计划白名单、执行状态与复现状态分离、取证登记、预算与清理语义。
// 全程使用脚本化假驱动：确定性、无浏览器依赖（真实 Playwright 驱动属环境接入，见 docs）。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserDriver, BrowserRunResult, ReproductionPlan } from "./contracts.ts";
import { BrowserRunner, PlanRejectedError } from "./browser-runner.ts";

const OK_PLAN = {
  entryUrl: "https://test.example.com/app",
  steps: [
    { stepId: "s1", label: "打开页面", action: { action: "goto", url: "https://test.example.com/app" } },
    { stepId: "s2", label: "填写详细地址", action: { action: "fill", selector: "#address", text: "新地址" } },
    { stepId: "s3", label: "保存", action: { action: "click", selector: "#save" } },
    { stepId: "s4", label: "刷新", action: { action: "reload" } },
    {
      stepId: "s5",
      label: "断言保存生效",
      action: { action: "assert_text", selector: "#address", expected: "新地址", comparison: "equals" },
    },
  ],
};

function fakeDriver(result: BrowserRunResult, record?: { plans?: ReproductionPlan[] }): BrowserDriver {
  return {
    name: "fake-driver",
    async execute(plan, _signal) {
      record?.plans?.push(plan);
      return result;
    },
  };
}

function runnerWith(result: BrowserRunResult, record?: { plans?: ReproductionPlan[] }): BrowserRunner {
  return new BrowserRunner({ driver: fakeDriver(result, record), maxSteps: 12 });
}

const COMPLETED_REPRODUCED: BrowserRunResult = {
  execution: "completed",
  reproduction: "reproduced",
  steps: [
    { stepId: "s1", action: "goto", status: "passed" },
    { stepId: "s5", action: "assert_text", status: "failed", detail: "期望 新地址，实际 旧地址" },
  ],
  consoleErrors: ["Uncaught TypeError: x is not a function"],
  requests: [
    {
      requestId: "r1",
      url: "https://test.example.com/api/save",
      method: "POST",
      status: 200,
      responseBody: '{"code":"OK","data":{"address":"新地址"}}',
    },
  ],
};

test("合法计划照原样传给驱动，断言失败但业务断言完成 → 已复现", async () => {
  const record: { plans?: ReproductionPlan[] } = { plans: [] };
  const runner = runnerWith(COMPLETED_REPRODUCED, record);
  const { result, evidenceInputs } = await runner.run(OK_PLAN, new AbortController().signal);

  assert.equal(record.plans?.length, 1, "计划通过校验后交给驱动执行");
  assert.equal(result.execution, "completed");
  assert.equal(result.reproduction, "reproduced", "断言失败 = 复现了异常（这是 bug 存在的证据）");
  assert.ok(evidenceInputs.length > 0);
  // 取证材料被截断成 EvidenceInput：网络 / 控制台 / 失败步骤各就各位
  const network = evidenceInputs.filter((e) => e.browserRef?.channel === "network");
  const console_ = evidenceInputs.filter((e) => e.browserRef?.channel === "console");
  const page = evidenceInputs.filter((e) => e.browserRef?.channel === "page");
  assert.equal(network.length, 1);
  assert.equal(console_.length, 1);
  assert.equal(page.length, 1, "失败步骤留页面取证");
});

test("白名单校验：未知动作 / 坏 URL / 超步数 在开浏览器之前拒绝", async () => {
  const record: { plans?: ReproductionPlan[] } = { plans: [] };
  const runner = runnerWith(COMPLETED_REPRODUCED, record);

  await assert.rejects(
    () => runner.run({ entryUrl: OK_PLAN.entryUrl, steps: [{ stepId: "s1", action: { action: "evaluate", script: "window.hack()" } }] } as never, new AbortController().signal),
    PlanRejectedError,
    "词表外的动作（任意脚本）必须拒收",
  );
  await assert.rejects(
    () => runner.run({ entryUrl: "file:///etc/passwd", steps: [{ stepId: "s1", action: { action: "reload" } }] }, new AbortController().signal),
    PlanRejectedError,
  );
  await assert.rejects(
    () => runner.run({ entryUrl: OK_PLAN.entryUrl, steps: [] }, new AbortController().signal),
    PlanRejectedError,
  );
  const strictRunner = new BrowserRunner({ driver: fakeDriver(COMPLETED_REPRODUCED), maxSteps: 2 });
  await assert.rejects(
    () => strictRunner.run(OK_PLAN, new AbortController().signal),
    PlanRejectedError,
    "步数预算在执行前校验",
  );
  assert.equal(record.plans?.length, 0, "校验失败一次都不开浏览器");
});

test("执行失败 ≠ 未复现：找不到按钮是执行失败，复现状态保持 indeterminate", async () => {
  const runner = runnerWith({
    execution: "failed",
    reproduction: "not_reproduced",
    steps: [
      { stepId: "s1", action: "goto", status: "passed" },
      { stepId: "s3", action: "click", status: "failed", error: "等待 #save 超时" },
    ],
    consoleErrors: [],
    requests: [],
  });
  const { result } = await runner.run(OK_PLAN, new AbortController().signal);
  assert.equal(result.execution, "failed");
  assert.equal(result.reproduction, "indeterminate", "没跑到业务断言，不许宣布 not_reproduced");
});

test("执行被阻塞（驱动抛异常）→ blocked + indeterminate，全部步骤记 skipped", async () => {
  const runner = new BrowserRunner({
    driver: {
      name: "broken-driver",
      execute: async () => {
        throw new Error("playwright 未安装");
      },
    },
  });
  const { result, evidenceInputs } = await runner.run(OK_PLAN, new AbortController().signal);
  assert.equal(result.execution, "blocked");
  assert.equal(result.reproduction, "indeterminate");
  assert.ok(result.steps.every((s) => s.status === "skipped"));
  assert.ok(result.steps.every((s) => s.error?.includes("环境阻塞")));
  assert.equal(evidenceInputs.length, 1, "阻塞本身也留取证");
});

test("未跑完不许宣称复现：驱动说谎时归一化强制改回 indeterminate", async () => {
  const runner = runnerWith({
    execution: "failed",
    reproduction: "reproduced",
    steps: [{ stepId: "s1", action: "goto", status: "passed" }],
    consoleErrors: [],
    requests: [],
  });
  const { result } = await runner.run(OK_PLAN, new AbortController().signal);
  assert.equal(result.reproduction, "indeterminate");
});

test("登录失效（环境类失败）场景：步骤失败 + blocked 语义不吞掉取证", async () => {
  const runner = runnerWith({
    execution: "failed",
    reproduction: "indeterminate",
    steps: [
      { stepId: "s1", action: "goto", status: "passed" },
      { stepId: "s2", action: "fill", status: "failed", error: "登录页出现：会话已过期" },
    ],
    consoleErrors: [],
    requests: [
      { requestId: "r1", url: "https://test.example.com/api/me", method: "GET", status: 401 },
    ],
  });
  const { result, evidenceInputs } = await runner.run(OK_PLAN, new AbortController().signal);
  assert.equal(result.execution, "failed");
  assert.equal(result.reproduction, "indeterminate");
  assert.equal(evidenceInputs.filter((e) => e.browserRef?.channel === "network").length, 1);
});
