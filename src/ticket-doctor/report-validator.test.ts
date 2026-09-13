// 报告校验器测试：引用正确性由程序判定，强制降级规则机器可查。
// 覆盖设计验收标准：伪造 ID / 跨运行引用 / 空证据高置信度 / 版本不匹配 / 未复现宣称验证。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./contracts.ts";
import { EvidenceStore } from "./evidence-store.ts";
import { validateReportDraft, type ReportDraft } from "./report-validator.ts";

const CONTEXT: RunContext = {
  runId: "run_val",
  ticketId: "BUG-V1",
  repos: [{ repoId: "app", rev: "HEAD", sha: "a".repeat(40) }],
};

function makeStore(): EvidenceStore {
  const store = new EvidenceStore(CONTEXT.runId);
  store.register({
    kind: "log",
    excerpt: "ERROR InventoryClient timeout after 3000ms",
    source: "log-src",
    level: "ERROR",
    time: 1_788_660_000_000,
  });
  store.register({
    kind: "code",
    excerpt: "throw new IllegalStateException();",
    codeRef: { repoId: "app", sha: "a".repeat(40), path: "src/Order.java", startLine: 88, endLine: 88 },
  });
  return store;
}

function baseDraft(overrides: Partial<ReportDraft> = {}): ReportDraft {
  return {
    status: "complete",
    hypotheses: [],
    suggestedNextSteps: [],
    ...overrides,
  };
}

function draftWith(ids: string[], overrides: Partial<ReportDraft> = {}): ReportDraft {
  return baseDraft({
    hypotheses: [
      { cause: "库存服务超时", confidence: "high", evidenceIds: ids, status: "candidate" },
    ],
    ...overrides,
  });
}

test("有效引用：通过，证据由系统解析填充（来源与位置不靠模型复述）", () => {
  const validation = validateReportDraft(draftWith(["E1", "E2"]), {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
  });
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  const h = validation.report.hypotheses[0];
  assert.equal(h.evidence.length, 2);
  assert.equal(h.evidence[0].evidenceId, "E1");
  assert.equal(h.evidence[0].source, "log-src");
  assert.equal(h.evidence[1].codeRef?.path, "src/Order.java");
  assert.equal(h.evidence[1].codeRef?.startLine, 88);
  assert.equal(h.status, "candidate", "没有复现确认时 verified/supported 之外的候选保持 candidate");
  assert.equal(validation.corrections.length, 0);
});

test("伪造/跨运行引用：打回（revise），列出未知 ID", () => {
  const validation = validateReportDraft(draftWith(["E1", "E999"]), {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
  });
  assert.equal(validation.decision, "revise");
  assert(validation.decision === "revise");
  const codes = validation.issues.map((i) => i.code);
  assert(codes.includes("evidence_not_found"));
  // 跨运行引用在语义上等价于"本次运行里不存在的 ID"——按运行隔离，同样打回
  const foreignStore = new EvidenceStore("run_OTHER");
  foreignStore.register({ kind: "log", excerpt: "别次运行的证据", source: "other" });
  const crossRun = validateReportDraft(draftWith(["E1"]), {
    store: foreignStore,
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
  });
  assert.equal(crossRun.decision, "revise");
});

test("版本不匹配：代码证据的 SHA 与运行钉死版本不一致 → 打回", () => {
  const store = new EvidenceStore(CONTEXT.runId);
  store.register({
    kind: "code",
    excerpt: "return wrongVersion();",
    codeRef: { repoId: "app", sha: "b".repeat(40), path: "src/X.java", startLine: 1, endLine: 1 },
  });
  const validation = validateReportDraft(draftWith(["E1"]), {
    store,
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
  });
  assert.equal(validation.decision, "revise");
  assert(validation.decision === "revise");
  assert(validation.issues.some((i) => i.code === "version_mismatch"));
});

test("空证据却高置信度：强制降 low + candidate（final=true 时接受降级版）", () => {
  const opts = {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
    final: true,
  };
  const validation = validateReportDraft(
    draftWith([], { status: "complete" }),
    opts,
  );
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  const h = validation.report.hypotheses[0];
  assert.equal(h.confidence, "low");
  assert.equal(h.status, "candidate");
  assert.ok(validation.corrections.some((c) => c.includes("强制降为 low")));
  // 报告材料完整性兜底：有假设但零有效证据 → partial
  assert.equal(validation.report.status, "partial");
  assert.ok(validation.report.missingMaterial?.some((m) => m.includes("有效证据")));
});

test("verified 的门槛：没有复现确认 → 降为 supported", () => {
  const validation = validateReportDraft(
    draftWith(["E1", "E2"], {
      hypotheses: [
        { cause: "x", confidence: "high", evidenceIds: ["E1", "E2"], status: "verified" },
      ],
      reproductionStatus: "not_reproduced",
    }),
    {
      store: makeStore(),
      context: CONTEXT,
      toolFailureCount: 0,
      browserReproduced: false,
    },
  );
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  assert.equal(validation.report.hypotheses[0].status, "supported");
  assert.ok(validation.corrections.some((c) => c.includes("supported")));

  // 复现确认后 verified 才能保留
  const verified = validateReportDraft(
    draftWith(["E1", "E2"], {
      hypotheses: [
        { cause: "x", confidence: "high", evidenceIds: ["E1", "E2"], status: "verified" },
      ],
      reproductionStatus: "reproduced",
    }),
    {
      store: makeStore(),
      context: CONTEXT,
      toolFailureCount: 0,
      browserReproduced: true,
    },
  );
  assert.equal(verified.decision, "accept");
  assert(verified.decision === "accept");
  assert.equal(verified.report.hypotheses[0].status, "verified");
});

test("宣称 reproduced 但浏览器没有复现证据：复现状态强制 indeterminate", () => {
  const validation = validateReportDraft(
    draftWith(["E1"], { reproductionStatus: "reproduced" }),
    {
      store: makeStore(),
      context: CONTEXT,
      toolFailureCount: 0,
      browserReproduced: false,
    },
  );
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  assert.equal(validation.report.reproductionStatus, "indeterminate");
  assert.ok(validation.corrections.some((c) => c.includes("indeterminate")));
});

test("材料完整性兜底：complete + 工具失败 → 强制 partial", () => {
  const validation = validateReportDraft(baseDraft(), {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 2,
    browserReproduced: false,
  });
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  assert.equal(validation.report.status, "partial");
});

test("final=true 时无效引用被丢弃并接受（修订轮次用尽的降级路径）", () => {
  const validation = validateReportDraft(draftWith(["E1", "E999"]), {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
    final: true,
  });
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  const h = validation.report.hypotheses[0];
  assert.deepEqual(h.evidenceIds, ["E1"], "无效 ID 已被剔除");
  assert.equal(h.evidence.length, 1);
});

test("同一假设重复引用同一 ID：自动去重（非致命）", () => {
  const validation = validateReportDraft(draftWith(["E1", "E1"]), {
    store: makeStore(),
    context: CONTEXT,
    toolFailureCount: 0,
    browserReproduced: false,
  });
  assert.equal(validation.decision, "accept");
  assert(validation.decision === "accept");
  assert.deepEqual(validation.report.hypotheses[0].evidenceIds, ["E1"]);
});
