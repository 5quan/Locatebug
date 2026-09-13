// 审计结论 → 程序动作的纯函数层。
//
// 审计 Agent 只提结论和建议的回流方向；"定向触发补证 / 假设修订 / 报告降级"由本文件执行。
// 铁律：已核实结论（verified/supported 假设及其证据）在降级时保留；每一处强制修改都记入
// corrections 可审计——降级不等于推翻，模型与审计都没说一不二的权力。

import type {
  AuditConclusion,
  AuditIssue,
  DiagnosisReport,
  RootCauseHypothesis,
} from "./contracts.ts";

export interface ApplyAuditOptions {
  /** 熔断/预算耗尽时置 true： corrections 里记升级说明 */
  escalated?: boolean;
  /** 触发降级的程序侧原因（如"回流预算耗尽"/"token 预算耗尽"/"同一维度连续失败，熔断"） */
  reason?: string;
}

const VERDICT_LABEL: Record<AuditConclusion["verdict"], string> = {
  pass: "通过",
  degrade: "有瑕疵（已标注）",
  reject: "未通过（已降级）",
};

function cloneHypothesis(h: RootCauseHypothesis): RootCauseHypothesis {
  return {
    ...h,
    evidence: [...(h.evidence ?? [])],
    evidenceIds: h.evidenceIds ? [...h.evidenceIds] : undefined,
    pendingChecks: h.pendingChecks ? [...h.pendingChecks] : undefined,
  };
}

/** 把审计意见落到指定假设的待验证项（保留原有待验证项）。 */
function appendPending(h: RootCauseHypothesis, text: string): void {
  h.pendingChecks = h.pendingChecks ?? [];
  if (!h.pendingChecks.includes(text)) h.pendingChecks.push(text);
}

/** 审计未通过时的确定性降级映射：verified→supported / 更严重→candidate + low。 */
function downgrade(h: RootCauseHypothesis, verdict: "degrade" | "reject", description: string, corrections: string[]): void {
  const original = `${h.status ?? "candidate"}/${h.confidence}`;
  if (verdict === "reject") {
    if (h.status !== "candidate") {
      h.status = "candidate";
      corrections.push(`审计未通过，假设「${h.cause}」的定位状态由 ${original} 强制降为 candidate/low：${description}`);
    }
    if (h.confidence !== "low") h.confidence = "low";
  } else {
    if (h.status === "verified") {
      h.status = "supported";
      corrections.push(`审计有瑕疵，假设「${h.cause}」的定位状态由 verified 强制降为 supported：${description}`);
    }
  }
  appendPending(h, `审计意见：${description}`);
}

/** 复现有效性问题 → 复现状态强制回到 indeterminate，verified 的门槛随之塌陷。 */
function applyReproductionIssue(report: DiagnosisReport, issue: AuditIssue, corrections: string[], verdict: AuditConclusion["verdict"]): void {
  if (report.reproductionStatus === "reproduced") {
    corrections.push(
      `审计对复现有效性提出异议（${issue.description}），reproductionStatus 已由 reproduced 强制改为 indeterminate`,
    );
    report.reproductionStatus = "indeterminate";
  }
  for (const h of report.hypotheses) {
    if (h.status === "verified") {
      if (verdict === "reject") {
        downgrade(h, "reject", `复现有效性未确认：${issue.description}`, corrections);
      } else {
        downgrade(h, "degrade", `复现有效性未确认：${issue.description}`, corrections);
      }
    }
  }
}

/** 归因充分性问题 → 指向具体假设则定向降级；未指向且为 reject 时，保守下调全部 verified。 */
function applyAttributionIssue(report: DiagnosisReport, issue: AuditIssue, corrections: string[], verdict: AuditConclusion["verdict"]): void {
  const targeted =
    issue.hypothesisIndex !== undefined && report.hypotheses[issue.hypothesisIndex] !== undefined;
  if (targeted) {
    downgrade(report.hypotheses[issue.hypothesisIndex!], verdict, issue.description, corrections);
    return;
  }
  if (verdict === "reject") {
    for (const h of report.hypotheses) {
      if (h.status === "verified") {
        h.status = "supported";
        corrections.push(`审计未通过且未定位到具体假设，假设「${h.cause}」的定位状态保守下调为 supported：${issue.description}`);
        appendPending(h, `审计意见：${issue.description}`);
      }
    }
  }
}

/**
 * 按审计结论对报告执行程序侧动作：
 * - pass：不修改报告，仅落档审计结论；
 * - degrade：按 issue 定向降级（有瑕疵但不阻断）；
 * - reject：定向降级 + 材料完整性兜底（有修正即 partial）。
 * 已核实结论及其证据一律保留；所有强制修改进 corrections。
 */
export function applyAuditConclusion(
  report: DiagnosisReport,
  conclusion: AuditConclusion,
  opts: ApplyAuditOptions = {},
): { report: DiagnosisReport; corrections: string[] } {
  const corrections: string[] = [];
  const next: DiagnosisReport = {
    ...report,
    hypotheses: report.hypotheses.map(cloneHypothesis),
    corrections: [...(report.corrections ?? [])],
  };

  if (conclusion.verdict === "pass") {
    next.audit = conclusion;
    return { report: next, corrections };
  }

  for (const issue of conclusion.issues) {
    if (issue.dimension === "reproduction_validity") {
      applyReproductionIssue(next, issue, corrections, conclusion.verdict);
    } else {
      applyAttributionIssue(next, issue, corrections, conclusion.verdict);
    }
  }

  if (opts.reason) {
    corrections.push(`${opts.reason}，报告按已核实结论 + 待验证项降级交付（审计结论：${VERDICT_LABEL[conclusion.verdict]}）`);
  }
  if (opts.escalated) {
    corrections.push("同一审计维度连续失败已熔断，停止回流；请人工复核以下审计意见");
  }

  // reject 时：只要发生过强制修正，材料完整性硬规则兜底为 partial
  if (conclusion.verdict === "reject" && corrections.length > 0 && next.status === "complete") {
    corrections.push("审计未通过且报告被强制降级，status 已由 complete 改判 partial");
    next.status = "partial";
  }

  next.corrections = corrections.length > 0 ? [...(next.corrections ?? []), ...corrections] : next.corrections;
  next.audit = conclusion;
  return { report: next, corrections };
}

/**
 * 保留已核实结论：把此前尝试中 verified/supported、且最终报告里没有的假设合并回来
 * （按 cause 去重；证据对象随假设一起保留——共享证据池里 ID 仍然有效）。
 */
export function mergePreserved(finalReport: DiagnosisReport, previousReports: DiagnosisReport[]): DiagnosisReport {
  const known = new Set(finalReport.hypotheses.map((h) => h.cause));
  const preserved: RootCauseHypothesis[] = [];
  for (const prev of previousReports) {
    for (const h of prev.hypotheses) {
      if (h.status !== "verified" && h.status !== "supported") continue;
      if (known.has(h.cause)) continue;
      known.add(h.cause);
      preserved.push(cloneHypothesis(h));
    }
  }
  if (preserved.length === 0) return finalReport;
  return {
    ...finalReport,
    hypotheses: [...finalReport.hypotheses, ...preserved],
    corrections: [
      ...(finalReport.corrections ?? []),
      `回流降级交付：从更早的尝试中保留了 ${preserved.length} 条已核实结论（含其证据）`,
    ],
  };
}
