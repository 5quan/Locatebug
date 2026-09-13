// AuditedDiagnosisEngine —— 诊断审计与定向回流的编排引擎（形态二：独立 Auditor + 程序驱动回流）。
//
// 它本身也是一个 DiagnosisEngine：包住一个"生成器"引擎和一个独立"审计 Agent"，
// 对上层（Runtime/写回层）暴露同一种事件流，Runtime 无需感知回流的存在。
//
// 循环：生成 → 审计（独立输入包，不含生成者中间推理）→
//   pass    → 交付（审计结论落档进报告）；
//   degrade → 程序定向降级后交付（有瑕疵但不阻断）；
//   reject  → 按问题类型定向回流（补证 / 假设修订），带失败历史重跑生成器。
//
// 四道闸门防无限循环（对应定稿"回流预算与重复失败检测"）：
//   1. 回流预算：最多 maxReflows 次回流（总尝试 ≤ maxReflows+1）；
//   2. 去重：失败历史注入下一轮生成上下文（auditFeedback），同样的错误不再用同样方式犯；
//   3. 熔断：同一审计维度连续两次未通过 → 停止回流，降级交付并升级人工复核；
//   4. Token 预算：所有尝试累计 token 超上限即停止回流（可选，未配置则不启用）。
// 超出预算不交付空结果：保留已核实结论 + 待验证项 + 审计意见，降级交付（status 兜底 partial）。
//
// 事件流约定：内部对每个事件重编 sequence（跨多次尝试保持单调）；run_started/skill_selected
// 只发一次；被审计打回的尝试的 run_completed 不外发（其报告进最终降级合成），其余事件全部
// 留痕——工具轨迹是审计与人工复核的依据，一层都不能丢。

import type {
  AgentEvent,
  AuditConclusion,
  DiagnosisAuditor,
  DiagnosisEngine,
  DiagnosisReport,
  QueryObservation,
  ReflowTarget,
  RunContext,
  TicketTask,
} from "./contracts.ts";
import { applyAuditConclusion, mergePreserved } from "./audit-actions.ts";
import { EvidenceStore } from "./evidence-store.ts";

export interface AuditedEngineOptions {
  generator: DiagnosisEngine;
  auditor: DiagnosisAuditor;
  /** 回流次数上限（不含首次生成），默认 2 → 总尝试最多 3 次 */
  maxReflows?: number;
  /** 所有尝试累计的 token 上限（input+output）；缺省不启用 */
  maxTotalTokens?: number;
}

interface AttemptCapture {
  report?: DiagnosisReport;
  terminal?: AgentEvent;
  observations: QueryObservation[];
}

const REFLOW_TARGETS: ReflowTarget[] = ["supplement_evidence", "revise_hypothesis", "downgrade_report"];

const DIMENSION_LABEL: Record<string, string> = {
  reproduction_validity: "复现有效性",
  attribution_sufficiency: "归因充分性",
};

export class AuditedDiagnosisEngine implements DiagnosisEngine {
  private readonly generator: DiagnosisEngine;
  private readonly auditor: DiagnosisAuditor;
  private readonly maxReflows: number;
  private readonly maxTotalTokens?: number;

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(opts: AuditedEngineOptions) {
    this.generator = opts.generator;
    this.auditor = opts.auditor;
    this.maxReflows = opts.maxReflows ?? 2;
    this.maxTotalTokens = opts.maxTotalTokens;
  }

  async *run(task: TicketTask, signal: AbortSignal, baseContext: RunContext): AsyncGenerator<AgentEvent> {
    const runId = baseContext.runId;
    let seq = 0;
    const now = () => Date.now();
    const renumber = (event: AgentEvent): AgentEvent => ({ ...event, sequence: ++seq });

    // 跨尝试共享证据池：证据 ID 全局唯一，"已核实结论"回流后依然可精确追溯
    const evidenceStore = baseContext.evidenceStore ?? new EvidenceStore(runId);
    const previousReports: DiagnosisReport[] = [];
    const failures: Array<{ attempt: number; conclusion: AuditConclusion }> = [];
    let totalTokens = 0;

    yield { type: "run_started", runId, sequence: ++seq, timestamp: now() };
    if (baseContext.skill) {
      yield { type: "skill_selected", runId, sequence: ++seq, timestamp: now(), skill: baseContext.skill };
    }

    let attempt = 0;
    while (true) {
      attempt += 1;

      // 去重反馈 + 已核实结论提示：回流不是"再来一次"，是带着失败原因重跑
      const feedback = this.renderFeedback(failures, previousReports);
      const context: RunContext = {
        ...baseContext,
        evidenceStore,
        ...(feedback.length > 0 ? { auditFeedback: feedback } : {}),
      };

      const capture: AttemptCapture = { observations: [] };
      for await (const event of this.generator.run(task, signal, context)) {
        switch (event.type) {
          case "run_started":
          case "skill_selected":
            break; // 由本引擎统一发，内层的不透传
          case "usage_reported":
            totalTokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
            yield renumber(event);
            break;
          case "observation_added":
            capture.observations.push(event.observation);
            yield renumber(event);
            break;
          case "run_completed":
            capture.report = event.result; // 暂存：审计后带结论再外发
            break;
          case "run_failed":
          case "run_cancelled":
            capture.terminal = event;
            yield renumber(event); // 生成器失败/取消：没有审计对象，维持原语义直接结束
            break;
          default:
            yield renumber(event);
            break;
        }
      }
      if (capture.terminal || !capture.report) {
        return;
      }
      const report = capture.report;
      previousReports.push(report);

      // ---- 独立审计：裁剪输入包（工单 + 报告 + 轨迹摘要 + 全部证据），对抗视角 ----
      let conclusion: AuditConclusion;
      try {
        conclusion = await this.auditor.audit(
          {
            task,
            report,
            observations: capture.observations,
            evidence: evidenceStore.all(),
            skill: baseContext.skill,
          },
          signal,
        );
      } catch (err) {
        // 审计自身失败不阻断交付，但必须如实声明"未经独立审计"
        const message = err instanceof Error ? err.message : String(err);
        const annotated: DiagnosisReport = {
          ...report,
          corrections: [...(report.corrections ?? []), `独立审计执行失败（${message}），报告未经独立审计，请按待验证项人工复核`],
        };
        yield {
          type: "run_completed",
          runId,
          sequence: ++seq,
          timestamp: now(),
          status: annotated.status,
          result: annotated,
          ...(annotated.status === "partial" ? { missingMaterial: annotated.missingMaterial } : {}),
        };
        return;
      }

      yield { type: "audit_completed", runId, sequence: ++seq, timestamp: now(), attempt, conclusion };

      if (conclusion.verdict === "pass") {
        yield this.deliver(runId, () => ++seq, now, applyAuditConclusion(report, conclusion).report);
        return;
      }
      if (conclusion.verdict === "degrade") {
        const { report: degraded } = applyAuditConclusion(report, conclusion);
        yield this.deliver(runId, () => ++seq, now, degraded);
        return;
      }

      // ---- reject：程序按问题类型定向回流 ----
      failures.push({ attempt, conclusion });

      // 熔断：同一维度连续两次未通过（连续失败才计，跨维度交替不算）
      if (this.isRepeatedDimension(failures)) {
        const reason = "同一审计维度连续两次未通过，熔断";
        const { report: degraded } = applyAuditConclusion(report, conclusion, { escalated: true, reason });
        const merged = mergePreserved(degraded, previousReports.slice(0, -1));
        yield this.deliver(runId, () => ++seq, now, merged);
        return;
      }
      // Token 预算：回流也烧 token，超限即停止
      if (this.maxTotalTokens !== undefined && totalTokens > this.maxTotalTokens) {
        const reason = `累计 token 用量 ${totalTokens} 已超 token 预算上限 ${this.maxTotalTokens}`;
        const { report: degraded } = applyAuditConclusion(report, conclusion, { reason });
        const merged = mergePreserved(degraded, previousReports.slice(0, -1));
        yield this.deliver(runId, () => ++seq, now, merged);
        return;
      }
      // 回流预算：总尝试 ≤ maxReflows + 1
      if (attempt >= this.maxReflows + 1) {
        const reason = `回流预算耗尽（已尝试 ${attempt} 次）`;
        const { report: degraded } = applyAuditConclusion(report, conclusion, { reason });
        const merged = mergePreserved(degraded, previousReports.slice(0, -1));
        yield this.deliver(runId, () => ++seq, now, merged);
        return;
      }

      const targets = this.clampTargets(conclusion.issues.map((i) => i.reflowTarget));
      yield {
        type: "reflow_triggered",
        runId,
        sequence: ++seq,
        timestamp: now(),
        attempt,
        targets,
        reasons: conclusion.issues.map(
          (i) => `${DIMENSION_LABEL[i.dimension] ?? i.dimension}：${i.description}（回流方向：${i.reflowTarget}）`,
        ),
      };
      // 继续下一次尝试（生成器收到 auditFeedback + 已核实结论提示）
    }
  }

  private deliver(
    runId: string,
    nextSeq: () => number,
    now: () => number,
    finalReport: DiagnosisReport,
  ): AgentEvent {
    return {
      type: "run_completed",
      runId,
      sequence: nextSeq(),
      timestamp: now(),
      status: finalReport.status,
      result: finalReport,
      ...(finalReport.status === "partial" ? { missingMaterial: finalReport.missingMaterial } : {}),
    };
  }

  /** 熔断判定：最近两次 reject 是同一维度。 */
  private isRepeatedDimension(failures: Array<{ attempt: number; conclusion: AuditConclusion }>): boolean {
    if (failures.length < 2) return false;
    const last = failures[failures.length - 1];
    const prev = failures[failures.length - 2];
    const dims = (c: AuditConclusion) => new Set(c.issues.map((i) => i.dimension));
    const lastDims = dims(last.conclusion);
    const prevDims = dims(prev.conclusion);
    if (lastDims.size === 0 || prevDims.size === 0) return false;
    // 两次的问题维度集合一致（且都非空）→ 同一类失败连续出现
    return (
      lastDims.size === prevDims.size &&
      [...lastDims].every((d) => prevDims.has(d))
    );
  }

  private clampTargets(targets: ReflowTarget[]): ReflowTarget[] {
    const set = new Set<ReflowTarget>();
    for (const t of targets) {
      if (REFLOW_TARGETS.includes(t)) set.add(t);
    }
    return [...set];
  }

  /**
   * 下一轮生成的反馈（去重注入）：
   * 1. 每次失败摘要（维度 + 描述 + 回流方向）；
   * 2. 已核实结论清单——明确要求保留，防止回流推翻已被证据支持的结论。
   */
  private renderFeedback(
    failures: Array<{ attempt: number; conclusion: AuditConclusion }>,
    previousReports: DiagnosisReport[],
  ): string[] {
    const lines: string[] = [];
    for (const f of failures) {
      lines.push(
        `第 ${f.attempt} 轮独立审计未通过，本轮必须针对性解决：` +
          f.conclusion.issues
            .map((i) => `[${DIMENSION_LABEL[i.dimension] ?? i.dimension}] ${i.description}（回流方向：${i.reflowTarget}）`)
            .join("；"),
      );
      if (f.conclusion.summary) lines.push(`审计总评：${f.conclusion.summary}`);
    }
    const verified: string[] = [];
    for (const report of previousReports) {
      for (const h of report.hypotheses) {
        if (h.status === "verified" || h.status === "supported") {
          verified.push(
            `- [${h.status}] ${h.cause}（证据：${(h.evidenceIds ?? h.evidence.map((e) => e.evidenceId) ?? []).join(", ") || "见证据池"}）`,
          );
        }
      }
    }
    if (verified.length > 0) {
      lines.push("以下结论已有证据支持且未被审计否定，本轮必须保留（可以继续补强，禁止无新证据地推翻）：");
      lines.push(...verified);
    }
    return lines;
  }
}
