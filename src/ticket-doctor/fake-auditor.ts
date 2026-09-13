// 审计 Agent 的确定性实现：测试用脚本化审计 + 离线演示用机械信号审计。
//
// defaultFakeAuditor 的定位：不调用模型，只看"程序可判定的机械信号"——
// 宣称复现但轨迹里没有浏览器复现结果、verified 假设没有证据引用等。
// 它审不了"证据是否真的支持解释"（那是模型审计的活），但能兜住最典型的过度归因。

import type {
  AuditConclusion,
  AuditInput,
  DiagnosisAuditor,
} from "./contracts.ts";

export type FakeAuditScript = (input: AuditInput, attempt: number) => AuditConclusion;

export class FakeDiagnosisAuditor implements DiagnosisAuditor {
  private readonly script?: FakeAuditScript;
  private calls = 0;

  constructor(script?: FakeAuditScript) {
    this.script = script;
  }

  async audit(input: AuditInput, _signal: AbortSignal): Promise<AuditConclusion> {
    this.calls += 1;
    if (this.script) return this.script(input, this.calls);
    return defaultFakeAuditorScript(input, this.calls);
  }
}

/** 确定性默认审计：只依据运行内的机械信号，绝不发明事实。 */
export const defaultFakeAuditorScript: FakeAuditScript = (input) => {
  const browserReproduced = input.observations.some(
    (o) => o.kind === "browser" && o.outcome?.reproduction === "reproduced",
  );
  const issues = [];

  // 复现有效性：宣称 reproduced，但轨迹里没有任何浏览器复现成功的观察
  if (input.report.reproductionStatus === "reproduced" && !browserReproduced) {
    issues.push({
      dimension: "reproduction_validity" as const,
      description: "报告宣称异常已复现，但本次运行的工具轨迹中没有浏览器复现成功的记录",
      reflowTarget: "supplement_evidence" as const,
    });
  }

  // 归因充分性：verified 必须有证据引用 + 复现支撑（与提示词硬规则对齐的机器侧复核）
  input.report.hypotheses.forEach((h, index) => {
    const evidenceCount = h.evidence?.length ?? 0;
    if (h.status === "verified" && (!browserReproduced || evidenceCount === 0)) {
      issues.push({
        dimension: "attribution_sufficiency" as const,
        description: `假设「${h.cause}」宣称根因已验证，但${evidenceCount === 0 ? "没有引用任何证据" : "缺少复现确认"}`,
        hypothesisIndex: index,
        reflowTarget: "revise_hypothesis" as const,
      });
    }
  });

  if (issues.length === 0) {
    return { verdict: "pass", issues: [], summary: "机械信号检查未发现问题" };
  }
  return {
    verdict: "reject",
    issues,
    summary: "存在可机械判定的过度归因信号",
  };
};
