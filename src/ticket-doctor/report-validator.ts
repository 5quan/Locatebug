// 报告校验器 —— "引用正确"和"推断成立"分开检查。
//
// 确定性检查（本文件，程序执行）：
//   - evidenceId 必须存在且属于本次运行（伪造 / 跨运行引用 = 打回）；
//   - 代码证据的 SHA 必须与运行钉死的版本一致（版本不匹配 = 打回）；
//   - 强制降级：没有有效证据不许说"根因已验证"，复现必须以浏览器运行结果为依据，
//     材料完整性（complete/partial）的硬规则由系统兜底，不信模型口头承诺。
//
// 诊断检查（证据是否真的支持该解释）不由本文件判定——它只能由复现与反证完成，
// 所以 verified 的门槛是"有效证据 + 复现确认"，而不是模型语气确定。

import type {
  DiagnosisReport,
  Evidence,
  HypothesisStatus,
  ReproductionStatus,
  RunContext,
} from "./contracts.ts";
import type { EvidenceStore } from "./evidence-store.ts";

// 模型提交的草稿形状（与 submit_report 的 TypeBox schema 对应，但去 SDK 化，纯数据可测）
export interface ReportDraft {
  status: "complete" | "partial";
  reproductionStatus?: ReproductionStatus;
  hypotheses: Array<{
    cause: string;
    confidence: "high" | "medium" | "low";
    evidenceIds?: string[];
    status?: HypothesisStatus;
    pendingChecks?: string[];
  }>;
  suggestedNextSteps: string[];
  missingMaterial?: string[];
}

export interface ValidationIssue {
  code:
    | "evidence_not_found" // 引用了不存在的 ID（伪造或跨运行）
    | "evidence_duplicate" // 同一假设重复引用同一 ID（自动去重）
    | "version_mismatch" // 代码证据版本与运行钉死版本不一致
    | "unverified_claim" // 无有效证据却宣称 verified/supported（已强制降级）
    | "unconfirmed_reproduction" // 宣称复现但没有本次运行的浏览器复现证据（已强制降级）
    | "material_status_forced" // complete/partial 与事实矛盾（已强制改判）
    | "hypothesis_status_forced"; // 定位状态与门槛矛盾（已强制降级）
  message: string;
  hypothesisIndex?: number;
  evidenceId?: string;
}

export interface ValidateOptions {
  store: EvidenceStore;
  context: RunContext;
  /** 本次运行失败的工具调用数（材料完整性硬规则的依据） */
  toolFailureCount: number;
  /** 本次运行浏览器复现是否确认复现（只认运行结果，不认模型口头宣布） */
  browserReproduced: boolean;
  /**
   * false = 常规校验：存在无法修复的引用问题 → 打回（revise），模型补证或降级；
   * true  = 修订轮次已用完：丢弃无效引用、保留全部强制降级，接受降级版报告。
   */
  final?: boolean;
}

export type DraftValidation =
  | { decision: "accept"; report: DiagnosisReport; corrections: string[]; issues: ValidationIssue[] }
  | { decision: "revise"; issues: ValidationIssue[] };

function shaMatchesRun(context: RunContext, repoId: string, sha: string): boolean {
  const repos = context.repos ?? [];
  if (repos.length === 0) return false; // 运行没有钉版本，代码证据无从谈起
  const binding = repos.find((r) => r.repoId === repoId) ?? repos.find((r) => r.sha === sha);
  // 仓 ID 匹配比对 SHA；仓 ID 不在运行上下文里时，按 SHA 兜底比对（同仓异名的配置误差）
  if (binding) return binding.sha === sha;
  return false;
}

export function validateReportDraft(draft: ReportDraft, opts: ValidateOptions): DraftValidation {
  const { store, context, toolFailureCount, browserReproduced } = opts;
  const issues: ValidationIssue[] = [];
  const corrections: string[] = [];

  const hypotheses: DiagnosisReport["hypotheses"] = [];
  let validEvidenceCount = 0;

  draft.hypotheses.forEach((h, index) => {
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const rawId of h.evidenceIds ?? []) {
      const entry = store.get(rawId);
      if (!entry) {
        issues.push({
          code: "evidence_not_found",
          message: `证据 ${rawId} 不存在于本次运行（伪造引用或跨运行引用）`,
          hypothesisIndex: index,
          evidenceId: rawId,
        });
        continue;
      }
      if (entry.runId !== context.runId) {
        // 跨运行引用：ID 恰好存在但属于别的运行——按运行隔离，一律打回
        issues.push({
          code: "evidence_not_found",
          message: `证据 ${rawId} 属于运行 ${entry.runId}，不是本次运行的材料（跨运行引用）`,
          hypothesisIndex: index,
          evidenceId: rawId,
        });
        continue;
      }
      if (seen.has(rawId)) {
        issues.push({
          code: "evidence_duplicate",
          message: `证据 ${rawId} 在同一假设中被重复引用（已去重）`,
          hypothesisIndex: index,
          evidenceId: rawId,
        });
        continue;
      }
      seen.add(rawId);
      if (entry.codeRef && context.repos && !shaMatchesRun(context, entry.codeRef.repoId, entry.codeRef.sha)) {
        issues.push({
          code: "version_mismatch",
          message: `证据 ${rawId} 的代码版本 ${entry.codeRef.repoId}@${entry.codeRef.sha.slice(0, 10)} 与运行钉死版本不一致`,
          hypothesisIndex: index,
          evidenceId: rawId,
        });
        continue;
      }
      evidence.push({
        evidenceId: entry.evidenceId,
        source: entry.source,
        time: entry.time,
        level: entry.level,
        excerpt: entry.excerpt,
        truncated: entry.truncated,
        codeRef: entry.codeRef,
        browserRef: entry.browserRef,
      });
    }
    validEvidenceCount += evidence.length;

    // 强制降级：没有有效证据，置信度与定位状态都不能保持模型给的值
    let confidence = h.confidence;
    let status = h.status;
    if (evidence.length === 0) {
      if (confidence !== "low") {
        corrections.push(
          `假设 ${index + 1}「${h.cause}」没有有效证据引用，置信度已从 ${confidence} 强制降为 low`,
        );
        confidence = "low";
      }
      if (status === "verified" || status === "supported") {
        corrections.push(
          `假设 ${index + 1}「${h.cause}」没有有效证据引用，定位状态已从 ${status} 强制降为 candidate`,
        );
        issues.push({
          code: "unverified_claim",
          message: `假设 ${index + 1} 无有效证据却宣称 ${status}`,
          hypothesisIndex: index,
        });
        status = "candidate";
      } else if (status === undefined) {
        status = "candidate";
      }
    } else if (status === "verified") {
      // verified 的门槛：有效证据 + 复现确认。缺一个都只能算 supported。
      if (draft.reproductionStatus !== "reproduced" || !browserReproduced) {
        corrections.push(
          `假设 ${index + 1}「${h.cause}」宣称根因已验证，但本次运行未确认复现，定位状态已降为 supported`,
        );
        issues.push({
          code: "hypothesis_status_forced",
          message: `假设 ${index + 1} verified 需要复现确认`,
          hypothesisIndex: index,
        });
        status = "supported";
      }
    } else if (status === undefined) {
      status = evidence.length > 0 ? "supported" : "candidate";
    }

    hypotheses.push({
      cause: h.cause,
      confidence,
      evidence,
      evidenceIds: [...seen],
      status,
      pendingChecks: h.pendingChecks,
    });
  });

  // 复现状态只认运行结果：模型宣布 reproduced 但浏览器没确认 → 强制 indeterminate
  let reproductionStatus = draft.reproductionStatus;
  if (reproductionStatus === "reproduced" && !browserReproduced) {
    corrections.push("宣称异常已复现，但本次运行没有浏览器复现证据支持，复现状态已强制改为 indeterminate");
    issues.push({ code: "unconfirmed_reproduction", message: "reproduced 缺少浏览器复现证据" });
    reproductionStatus = "indeterminate";
  }

  // 材料完整性硬规则由系统兜底（2026-09-06 真机修正条款的机器可查形式）
  let status = draft.status;
  const missingMaterial = [...(draft.missingMaterial ?? [])];
  if (status === "complete") {
    if (toolFailureCount > 0) {
      corrections.push(`本次运行有 ${toolFailureCount} 次工具调用失败，status 已从 complete 强制改判 partial`);
      issues.push({ code: "material_status_forced", message: "complete 与工具失败事实矛盾" });
      status = "partial";
    }
    if (missingMaterial.length > 0) {
      corrections.push("status=complete 与 missingMaterial 同时出现，已强制改判 partial");
      issues.push({ code: "material_status_forced", message: "complete 与 missingMaterial 矛盾" });
      status = "partial";
    }
    if (draft.hypotheses.length > 0 && validEvidenceCount === 0) {
      corrections.push("形成了根因假设但全篇没有有效证据，status 已从 complete 强制改判 partial");
      issues.push({ code: "material_status_forced", message: "有假设但零有效证据" });
      status = "partial";
      if (missingMaterial.length === 0) {
        missingMaterial.push("支持根因假设的有效证据（所有引用均未命中本次运行的材料）");
      }
    }
  }

  const fatalIssues = issues.filter(
    (i) => i.code === "evidence_not_found" || i.code === "version_mismatch",
  );
  if (fatalIssues.length > 0 && !opts.final) {
    return { decision: "revise", issues };
  }

  const report: DiagnosisReport = {
    status,
    hypotheses,
    suggestedNextSteps: draft.suggestedNextSteps,
    reproductionStatus,
    ...(missingMaterial.length > 0 ? { missingMaterial } : {}),
    ...(corrections.length > 0 ? { corrections } : {}),
  };
  return { decision: "accept", report, corrections, issues };
}
