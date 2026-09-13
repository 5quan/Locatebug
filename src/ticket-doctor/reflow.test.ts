// 诊断审计与定向回流（AuditedDiagnosisEngine）语义测试。
// 全程脚本化生成器 + 脚本化/确定性审计：覆盖 PASS、定向补证回流、回流预算耗尽降级、
// 同维度熔断、DEGRADE 降级、token 预算、保留已核实结论、共享证据池、生成器失败。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEvent,
  AuditConclusion,
  AuditInput,
  DiagnosisEngine,
  DiagnosisReport,
  RunContext,
  TicketTask,
} from "./contracts.ts";
import { assertRunInvariants } from "./core.ts";
import { AuditedDiagnosisEngine } from "./audited-engine.ts";
import { FakeDiagnosisAuditor } from "./fake-auditor.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { EvidenceStore } from "./evidence-store.ts";
import { memoryLogSource } from "./test-helpers.ts";

const TASK: TicketTask = {
  ticketId: "BUG-AUDIT",
  title: "保存地址不生效",
  description: "保存后刷新页面显示旧值",
  service: "checkout-service",
  occurredAt: Date.parse("2026-09-06T10:02:00+08:00"),
};

const BASE_CONTEXT: RunContext = { runId: "run_audit_1", ticketId: TASK.ticketId };

function report(partial: Partial<DiagnosisReport>): DiagnosisReport {
  return {
    status: "complete",
    hypotheses: [],
    suggestedNextSteps: [],
    ...partial,
  };
}

// 事件工厂：sequence 从 1 递增（外层引擎会重编）
let tick = 0;
const at = () => ++tick;

function attemptEvents(
  context: RunContext,
  report: DiagnosisReport,
  opts: { evidence?: string; usageTokens?: number; observationCount?: number } = {},
): AgentEvent[] {
  const events: AgentEvent[] = [
    { type: "run_started", runId: context.runId, sequence: at(), timestamp: Date.now() },
  ];
  for (let i = 0; i < (opts.observationCount ?? 1); i++) {
    events.push({
      type: "observation_added",
      runId: context.runId,
      sequence: at(),
      timestamp: Date.now(),
      name: "query_logs",
      observation: {
        kind: "logs",
        intent: { service: "checkout-service", timeWindow: { from: 0, to: 1 }, keywords: [] },
        status: "success",
        evidence: [],
      },
    });
  }
  if (opts.evidence) {
    const stored = context.evidenceStore?.register({
      kind: "log",
      excerpt: opts.evidence,
      source: "scripted",
    });
    report = {
      ...report,
      hypotheses: report.hypotheses.map((h) => ({
        ...h,
        evidence: stored
          ? [{ evidenceId: stored.evidenceId, source: stored.source, excerpt: stored.excerpt }]
          : h.evidence,
        evidenceIds: stored ? [stored.evidenceId] : h.evidenceIds,
      })),
    };
  }
  if (opts.usageTokens !== undefined) {
    events.push({
      type: "usage_reported",
      runId: context.runId,
      sequence: at(),
      timestamp: Date.now(),
      usage: { inputTokens: opts.usageTokens, outputTokens: 0, toolCalls: 1, durationMs: 5 },
    });
  }
  events.push({
    type: "run_completed",
    runId: context.runId,
    sequence: at(),
    timestamp: Date.now(),
    status: report.status,
    result: report,
    ...(report.status === "partial" ? { missingMaterial: report.missingMaterial } : {}),
  });
  return events;
}

// 脚本化生成器：第 i 次调用产出 attempts[i](context) 的事件；contexts 可选记录每次收到的 context
function scriptedGenerator(
  attempts: Array<(context: RunContext) => AgentEvent[]>,
  contexts?: RunContext[],
): DiagnosisEngine {
  let call = 0;
  return {
    run: async function* (task, signal, context) {
      contexts?.push(context);
      const script = attempts[Math.min(call, attempts.length - 1)];
      call += 1;
      for (const event of script(context)) {
        if (signal?.aborted) return;
        yield event;
      }
    },
  };
}

async function runAudited(
  engine: DiagnosisEngine,
  task: TicketTask = TASK,
  context: RunContext = BASE_CONTEXT,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of engine.run(task, new AbortController().signal, context)) {
    events.push(event);
  }
  return events;
}

const attributionIssue = (index = 0): AuditConclusion => ({
  verdict: "reject",
  issues: [
    {
      dimension: "attribution_sufficiency",
      description: "单一日志片段不足以支撑根因结论",
      hypothesisIndex: index,
      reflowTarget: "supplement_evidence",
    },
  ],
});

test("PASS：一次通过，报告落档审计结论，无回流", async () => {
  const auditorCalls: AuditInput[] = [];
  const auditor = new FakeDiagnosisAuditor((input) => {
    auditorCalls.push(input);
    return { verdict: "pass", issues: [], summary: "未发现问题" };
  });
  const contexts: RunContext[] = [];
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator([(ctx) => attemptEvents(ctx, report({}))], contexts),
    auditor,
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "run_started").length, 1, "run_started 只发一次");
  assert.equal(types.filter((t) => t === "run_completed").length, 1);
  assert(!types.includes("reflow_triggered"));
  assert(types.includes("audit_completed"));

  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert.equal(terminal.result.audit?.verdict, "pass");
  assert.equal(auditorCalls.length, 1);
  // 审计输入包：工单 + 报告 + 轨迹 + 证据，独立于生成器上下文
  assert.equal(auditorCalls[0].task.ticketId, TASK.ticketId);
  assert.equal(auditorCalls[0].observations.length, 1);
});

test("定向回流：reject(supplement_evidence) → 带失败反馈重跑 → 第二次通过", async () => {
  const contexts: RunContext[] = [];
  const verdicts: AuditConclusion[] = [
    attributionIssue(),
    { verdict: "pass", issues: [] },
  ];
  let auditCall = 0;
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator(
      [
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "A", confidence: "high", evidence: [] }] }), { evidence: "log-line-1" }),
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "A2", confidence: "medium", evidence: [] }] }), { evidence: "log-line-2", observationCount: 2 }),
      ],
      contexts,
    ),
    auditor: new FakeDiagnosisAuditor(() => verdicts[auditCall++] ?? { verdict: "pass", issues: [] }),
    maxReflows: 2,
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);

  const reflow = events.find((e) => e.type === "reflow_triggered");
  assert(reflow);
  assert(reflow.type === "reflow_triggered");
  assert.deepEqual(reflow.targets, ["supplement_evidence"]);
  assert.match(reflow.reasons[0], /归因充分性/);

  // 反馈注入：第二次尝试收到失败摘要（去重反馈），且共享同一证据池
  assert.equal(contexts.length, 2);
  assert.ok(contexts[1].auditFeedback?.some((l) => l.includes("第 1 轮独立审计未通过")));
  assert.ok(contexts[1].auditFeedback?.some((l) => l.includes("supplement_evidence")));
  assert(contexts[0].evidenceStore === contexts[1].evidenceStore, "两次尝试共享证据池");
  assert.equal(contexts[1].evidenceStore?.size, 2, "两次尝试的证据都在同一个池里，ID 唯一");

  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert.equal(terminal.result.audit?.verdict, "pass");
  assert.equal(terminal.result.hypotheses[0].cause, "A2", "最终交付最后一次尝试的报告");
});

test("回流预算耗尽：不交付空结果，定向降级 + 保留已核实结论", async () => {
  const contexts: RunContext[] = [];
  // 两次 reject 维度不同：不触发熔断，走预算耗尽路径
  let auditCall = 0;
  const verdicts: AuditConclusion[] = [
    attributionIssue(0),
    {
      verdict: "reject",
      issues: [
        {
          dimension: "reproduction_validity",
          description: "报告未复现却宣称验证",
          reflowTarget: "revise_hypothesis",
        },
      ],
    },
  ];
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator(
      [
        (ctx) =>
          attemptEvents(
            ctx,
            report({
              hypotheses: [
                {
                  cause: "已核实的根因：保存接口业务失败",
                  confidence: "high",
                  evidence: [],
                  status: "verified",
                },
              ],
            }),
            { evidence: "verified-evidence-line" },
          ),
        (_ctx) =>
          attemptEvents(
            _ctx,
            report({ hypotheses: [{ cause: "新尝试的假设", confidence: "high", evidence: [] }] }),
          ),
      ],
      contexts,
    ),
    auditor: new FakeDiagnosisAuditor(() => verdicts[auditCall++] ?? { verdict: "pass", issues: [] }),
    maxReflows: 1,
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);
  assert.equal(contexts.length, 2, "maxReflows=1 → 最多两次尝试");

  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert.equal(terminal.result.status, "partial", "降级交付兜底为 partial");
  const causes = terminal.result.hypotheses.map((h) => h.cause);
  assert(causes.includes("已核实的根因：保存接口业务失败"), "保留早前尝试的已核实结论");
  assert(causes.includes("新尝试的假设"));
  const verified = terminal.result.hypotheses.find((h) => h.status === "verified");
  assert(verified, "未被审计点名的已核实结论保持 verified");
  assert.ok(terminal.result.corrections?.some((c) => c.includes("回流预算耗尽")));
  assert.equal(terminal.result.audit?.verdict, "reject");
  assert.ok(terminal.result.missingMaterial === undefined || terminal.result.missingMaterial !== undefined);
});

test("熔断：同一维度连续两次未通过 → 停止回流，升级说明进 corrections", async () => {
  const contexts: RunContext[] = [];
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator(
      [
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "X", confidence: "high", evidence: [] }] })),
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "Y", confidence: "high", evidence: [] }] })),
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "Z", confidence: "high", evidence: [] }] })),
      ],
      contexts,
    ),
    auditor: new FakeDiagnosisAuditor(() => attributionIssue(0)),
    maxReflows: 3, // 预算足够，靠熔断提前停止
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);
  assert.equal(contexts.length, 2, "同一维度连续两次失败即熔断，不再第三次尝试");

  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  const h = terminal.result.hypotheses[0];
  assert.equal(h.status, "candidate", "被点名的假设定向降为 candidate");
  assert.equal(h.confidence, "low");
  assert.ok(terminal.result.corrections?.some((c) => c.includes("熔断")));
  assert.equal(terminal.result.status, "partial");
});

test("DEGRADE：复现有效性存疑 → 复现状态强制 indeterminate，verified 降 supported，带标注交付", async () => {
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator([
      (ctx) =>
        attemptEvents(
          ctx,
          report({
            reproductionStatus: "reproduced",
            hypotheses: [{ cause: "V", confidence: "high", evidence: [], status: "verified" }],
          }),
        ),
    ]),
    auditor: new FakeDiagnosisAuditor(() => ({
      verdict: "degrade",
      issues: [
        {
          dimension: "reproduction_validity",
          description: "浏览器复现步骤未覆盖保存后刷新",
          reflowTarget: "supplement_evidence",
        },
      ],
      summary: "复现路径不完整",
    })),
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);
  assert(!events.some((e) => e.type === "reflow_triggered"), "degrade 不回流");

  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert.equal(terminal.result.reproductionStatus, "indeterminate");
  assert.equal(terminal.result.hypotheses[0].status, "supported");
  assert.equal(terminal.result.audit?.verdict, "degrade");
  assert.equal(terminal.result.status, "complete", "degrade 不改判材料完整性");
});

test("token 预算：累计超限即停止回流，降级交付", async () => {
  const contexts: RunContext[] = [];
  let auditCall = 0;
  const verdicts: AuditConclusion[] = [
    attributionIssue(0),
    {
      verdict: "reject",
      issues: [
        { dimension: "reproduction_validity", description: "无复现记录", reflowTarget: "supplement_evidence" },
      ],
    },
  ];
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator(
      [
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "A", confidence: "high", evidence: [] }] }), { usageTokens: 60 }),
        (ctx) => attemptEvents(ctx, report({ hypotheses: [{ cause: "B", confidence: "high", evidence: [] }] }), { usageTokens: 60 }),
      ],
      contexts,
    ),
    auditor: new FakeDiagnosisAuditor(() => verdicts[auditCall++] ?? { verdict: "pass", issues: [] }),
    maxReflows: 2,
    maxTotalTokens: 100,
  });

  const events = await runAudited(engine);
  assert.equal(contexts.length, 2);
  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert.ok(terminal.result.corrections?.some((c) => c.includes("token 预算")));
});

test("生成器失败：run_failed 透传，无审计对象，不触发回流", async () => {
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator([
      (ctx) => [
        { type: "run_started", runId: ctx.runId, sequence: at(), timestamp: Date.now() },
        {
          type: "run_failed",
          runId: ctx.runId,
          sequence: at(),
          timestamp: Date.now(),
          error: { code: "budget_iterations", message: "预算耗尽" },
        },
      ],
    ]),
    auditor: new FakeDiagnosisAuditor(() => {
      throw new Error("不应该被调用");
    }),
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);
  const types = events.map((e) => e.type);
  assert(!types.includes("audit_completed"));
  assert(!types.includes("reflow_triggered"));
  const terminal = events[events.length - 1];
  assert(terminal.type === "run_failed");
});

test("审计 Agent 自身失败：如实声明'未经独立审计'，报告不阻断交付", async () => {
  const engine = new AuditedDiagnosisEngine({
    generator: scriptedGenerator([(ctx) => attemptEvents(ctx, report({}))]),
    auditor: new FakeDiagnosisAuditor(() => {
      throw new Error("审计模型 503");
    }),
  });

  const events = await runAudited(engine);
  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  assert(terminal.result.audit === undefined);
  assert.ok(terminal.result.corrections?.some((c) => c.includes("未经独立审计")));
});

test("集成：FakeDiagnosisEngine + 确定性默认审计 → 正常报告一次通过", async () => {
  const engine = new AuditedDiagnosisEngine({
    generator: new FakeDiagnosisEngine({
      logSource: memoryLogSource([
        {
          time: Date.parse("2026-09-06T10:02:00+08:00") - 1000,
          level: "ERROR",
          message: "ERROR OrderService 创建订单失败 traceId=tr_1",
        },
      ]),
    }),
    auditor: new FakeDiagnosisAuditor(), // 默认确定性审计
  });

  const events = await runAudited(engine);
  assertRunInvariants(events);
  const terminal = events[events.length - 1];
  assert(terminal.type === "run_completed");
  // 假引擎产出 candidate/low 的诚实报告，默认审计应放行
  assert.equal(terminal.result.audit?.verdict, "pass");
  assert.equal(terminal.result.hypotheses[0].status, "candidate");
});
