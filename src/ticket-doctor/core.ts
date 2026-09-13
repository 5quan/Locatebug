// Core 的纯函数层：事件流 ⇄ 状态 ⇄ 报告。
// 全部是确定性纯函数：不碰网络、不碰文件、不取当前时间（时间由事件自带）。
// 测试、RunLog 回放、报告渲染都构建在这些函数上。

import type {
  AgentEvent,
  AuditDimension,
  AuditVerdict,
  DiagnosisReport,
  QueryObservation,
  RootCauseHypothesis,
  TicketTask,
} from "./contracts.ts";

// 一次诊断运行的领域状态（对应 skill 的 AgentState，裁剪到本产品需要的字段）
export interface AgentState {
  task: TicketTask;
  observations: QueryObservation[];
  iterations: number; // 完成的迭代数（每个 observation_added 记一次）
}

// ---------- 回放：事件日志是唯一事实源，状态从事件推导（skill「Storage contracts」） ----------

const TERMINAL_TYPES = new Set(["run_completed", "run_failed", "run_cancelled"]);

// 终态判定：Runtime 的"无终态守卫"和 RunLog 的 listRuns 都要用
export function isTerminalEvent(event: AgentEvent): boolean {
  return TERMINAL_TYPES.has(event.type);
}

export function replayAgentState(
  events: AgentEvent[],
  task: TicketTask,
): { state: AgentState; terminal?: AgentEvent } {
  const state: AgentState = { task, observations: [], iterations: 0 };
  let terminal: AgentEvent | undefined;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "observation_added") {
      state.observations.push(event.observation);
      state.iterations++;
    } else if (TERMINAL_TYPES.has(event.type)) {
      terminal = event;
    }
  }
  return { state, terminal };
}

// ---------- 提取：从事件流里取出最终报告 ----------

export function terminalEvent(events: AgentEvent[]): AgentEvent | undefined {
  return events.find((e) => TERMINAL_TYPES.has(e.type));
}

// 只有 run_completed 携带报告；run_failed / run_cancelled 没有报告可提取
export function extractReport(events: AgentEvent[]): DiagnosisReport | undefined {
  const terminal = terminalEvent(events);
  return terminal?.type === "run_completed" ? terminal.result : undefined;
}

// ---------- 不变量校验：任何事件集合（内存里的或从 RunLog 读回的）都必须满足 ----------
// 这是 skill 退出清单「每个 Run 有有序生命周期和唯一终态」的机器可查形式。

export function assertRunInvariants(events: AgentEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    if (events[i].sequence <= events[i - 1].sequence) {
      throw new Error(
        `事件序列必须严格单调递增：seq=${events[i].sequence} 出现在 seq=${events[i - 1].sequence} 之后`,
      );
    }
  }
  const terminals = events.filter((e) => TERMINAL_TYPES.has(e.type));
  if (terminals.length > 1) {
    throw new Error(`终态事件必须唯一，实际有 ${terminals.length} 个`);
  }
  if (terminals.length === 1 && events[events.length - 1] !== terminals[0]) {
    throw new Error("终态事件必须是最后一个事件");
  }
}

// ---------- 报告渲染：DiagnosisReport → 写回工单备注的文本（产品面） ----------
// 纯函数所以 golden 测试可以钉住格式；阶段 4 的 TicketReporter 只负责把这段文本发出去。

const CONFIDENCE_LABEL: Record<RootCauseConfidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

type RootCauseConfidence = DiagnosisReport["hypotheses"][number]["confidence"];

// 定位状态标签：报告里必须能区分"根因已验证"和"候选原因"，两者不允许混用措辞
const HYPOTHESIS_STATUS_LABEL: Record<NonNullable<RootCauseHypothesisStatus>, string> = {
  verified: "根因已验证",
  supported: "已获支持",
  candidate: "候选原因",
  refuted: "已排除",
};

type RootCauseHypothesisStatus = DiagnosisReport["hypotheses"][number]["status"];

const REPRODUCTION_LABEL: Record<NonNullable<ReproductionStatus>, string> = {
  reproduced: "异常已复现",
  not_reproduced: "未复现",
  indeterminate: "复现状态无法判断",
  blocked: "复现被环境阻塞",
};

type ReproductionStatus = DiagnosisReport["reproductionStatus"];

const AUDIT_VERDICT_LABEL: Record<AuditVerdict, string> = {
  pass: "独立审计：通过",
  degrade: "独立审计：有瑕疵（已标注，供参考）",
  reject: "独立审计：未通过（已按意见降级交付）",
};

const AUDIT_DIMENSION_LABEL: Record<AuditDimension, string> = {
  reproduction_validity: "复现有效性",
  attribution_sufficiency: "归因充分性",
};

function formatTime(ms: number): string {
  // 日志证据统一用东八区展示，和测试同学看日志平台的习惯一致
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

// 代码证据的精确定位（系统从 codeRef 渲染，模型不负责填行号）
function renderCodeRef(ref: NonNullable<import("./contracts.ts").Evidence["codeRef"]>): string {
  const shortSha = ref.sha.length > 10 ? ref.sha.slice(0, 10) : ref.sha;
  const line = ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}-L${ref.endLine}`;
  return `${ref.repoId}@${shortSha} ${ref.path}#${line}`;
}

export function renderTicketComment(task: TicketTask, report: DiagnosisReport): string {
  const lines: string[] = [];
  lines.push(`【AI 预检报告】${task.title}`);
  lines.push("");
  lines.push(`> 由 ticket-doctor 自动生成（ticketId=${task.ticketId}），供接手开发参考，非最终结论。`);
  lines.push("");
  if (report.reproductionStatus) {
    lines.push(`**复现状态：${REPRODUCTION_LABEL[report.reproductionStatus]}**`);
    lines.push("");
  }
  if (report.audit) {
    lines.push(`**${AUDIT_VERDICT_LABEL[report.audit.verdict]}**`);
    for (const issue of report.audit.issues) {
      lines.push(`- 审计意见[${AUDIT_DIMENSION_LABEL[issue.dimension]}]：${issue.description}${issue.evidenceRef ? `（核对：${issue.evidenceRef}）` : ""}`);
    }
    lines.push("");
  }
  if (report.hypotheses.length === 0) {
    lines.push(
      report.status === "partial"
        ? "未能获取足够材料，未形成根因假设。"
        : "时间窗内未发现明显错误日志，未形成根因假设。",
    );
  } else {
    lines.push("## 根因假设");
    lines.push("");
    report.hypotheses.forEach((h, i) => {
      const statusLabel = h.status ? HYPOTHESIS_STATUS_LABEL[h.status] : undefined;
      const status = statusLabel ? `定位状态：${statusLabel}` : undefined;
      lines.push(
        `${i + 1}. [置信度：${CONFIDENCE_LABEL[h.confidence]}]${status ? `[${status}]` : ""} ${h.cause}`,
      );
      for (const ev of h.evidence) {
        const id = ev.evidenceId ? `${ev.evidenceId} ` : "";
        const time = ev.time ? formatTime(ev.time) : "";
        lines.push(
          `   - 证据 ${id}${time}${time ? " " : ""}${ev.level ? `[${ev.level}]` : ""} ${ev.excerpt}`.trimEnd(),
        );
        lines.push(`     来源：${ev.codeRef ? renderCodeRef(ev.codeRef) : ev.source}`);
      }
      if (h.pendingChecks && h.pendingChecks.length > 0) {
        for (const check of h.pendingChecks) {
          lines.push(`   - 待验证：${check}`);
        }
      }
    });
    lines.push("");
  }
  if (report.suggestedNextSteps.length > 0) {
    lines.push("## 建议下一步");
    lines.push("");
    for (const step of report.suggestedNextSteps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  if (report.status === "partial" || (report.missingMaterial && report.missingMaterial.length > 0)) {
    lines.push("## 局限（本次为部分结果）");
    lines.push("");
    for (const missing of report.missingMaterial ?? []) {
      lines.push(`- 缺失材料：${missing}`);
    }
    for (const correction of report.corrections ?? []) {
      lines.push(`- 校验修正：${correction}`);
    }
  } else if (report.corrections && report.corrections.length > 0) {
    lines.push("## 校验修正（系统强制）");
    lines.push("");
    for (const correction of report.corrections) {
      lines.push(`- ${correction}`);
    }
  }
  return lines.join("\n");
}

// ---------- 事件 → 一行人话（demo / 调试共用；纯函数） ----------

export function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "run_started":
      return `[${event.sequence}] run_started runId=${event.runId}`;
    case "skill_selected":
      return `[${event.sequence}] skill_selected ${event.skill.id}@${event.skill.version} sha=${event.skill.contentHash.slice(0, 12)}`;
    case "decision_made":
      return event.decision.kind === "call_tool"
        ? `[${event.sequence}] decision_made call_tool ${event.decision.name} ${JSON.stringify(event.decision.arguments)}`
        : `[${event.sequence}] decision_made respond（产出诊断报告）`;
    case "tool_started":
      return `[${event.sequence}] tool_started ${event.toolName}`;
    case "tool_completed":
      return `[${event.sequence}] tool_completed ${event.toolName} ${event.status} (${event.durationMs}ms)`;
    case "observation_added":
      return `[${event.sequence}] observation_added ${event.name} status=${event.observation.status} 证据=${event.observation.evidence.length}条`;
    case "usage_reported":
      return `[${event.sequence}] usage_reported ${JSON.stringify(event.usage)}`;
    case "audit_completed":
      return `[${event.sequence}] audit_completed 第${event.attempt}次 ${event.conclusion.verdict}（问题 ${event.conclusion.issues.length} 条）`;
    case "reflow_triggered":
      return `[${event.sequence}] reflow_triggered 第${event.attempt}次 定向回流 ${event.targets.join("+")}`;
    case "run_completed":
      return `[${event.sequence}] run_completed status=${event.status}`;
    case "run_failed":
      return `[${event.sequence}] run_failed ${event.error.code}: ${event.error.message}`;
    case "run_cancelled":
      return `[${event.sequence}] run_cancelled`;
  }
}
