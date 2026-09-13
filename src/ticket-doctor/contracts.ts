// 工单预检 Agent（ticket-doctor）的领域契约 —— Core 层。
//
// 铁律（对应 skill「Agent Core & Runtime」）：这个文件不允许 import 任何 SDK。
// Core 只回答一个问题："一次合法的 bug 诊断运行是什么意思？"
// 循环由谁驱动（假引擎 / Pi SDK 适配器）、日志从哪来（本地样例 / 真实日志平台）、
// 浏览器怎么开（Playwright / 假驱动），都属于适配器，通过下面的端口接进来。

import type { EvidenceStore } from "./evidence-store.ts";

// ---------- 输入：一张 bug 工单（对应 skill 的 Task） ----------

// 工单可携带的业务仓库引用（前后端分仓时逐仓给版本）
export interface RepositoryRef {
  repoId: string; // 业务仓标识（如 "frontend" / "backend"），由接入层映射到实际仓库目录
  rev?: string; // 该仓的版本（commit 哈希 / 可解析引用）；缺省 HEAD
}

export interface TicketTask {
  ticketId: string; // 业务工单身份：跨多次运行保持稳定（幂等键是 requestKey，见 Runtime）
  title: string;
  description: string;
  service?: string; // 所属服务，决定日志检索范围
  occurredAt?: number; // 发生时间（epoch ms），决定日志时间窗
  commit?: string; // 主仓代码版本的便捷字段（等价 repositories: [{ repoId: 主仓, rev: commit }]）
  // —— 复现驱动定位扩展：页面异常难以区分前端/接口/后端时，给 Agent 可复现的入口 ——
  entryUrl?: string; // 页面入口 URL（提供后浏览器复现工具才可能启用）
  expectedBehavior?: string; // 预期行为（业务断言的判定依据）
  actualBehavior?: string; // 实际行为
  reproductionSteps?: string[]; // 用户描述的操作步骤（模型生成受约束复现计划的参考）
  environmentId?: string; // 预先配置的测试环境标识（凭证由环境配置提供，不进工单正文）
  repositories?: RepositoryRef[]; // 前端、后端等仓库及版本
}

// ---------- 运行上下文：系统在运行开始时解析并钉死的值 ----------
// runId 由 Runtime 生成并传给引擎，引擎不得自行计算（评测/对照要求同一工单能跑多次）。

export interface RepoBinding {
  repoId: string;
  rev: string; // 工单给的原始引用
  sha: string; // 运行开始时解析出的完整 commit SHA，本次运行内不可变
}

export interface SkillBinding {
  id: string;
  version: string;
  contentHash: string; // SKILL.md 原文的 sha256，事件与报告据此追溯"当时用的是哪一版"
  source?: string; // 加载来源（目录 / 内嵌）
}

export interface RunContext {
  runId: string;
  ticketId: string;
  requestKey?: string; // 同一次提交的幂等身份（Runtime 计算/透传）
  repos?: RepoBinding[]; // 本次运行钉死的源码版本（前后端分仓时多份）
  environmentId?: string;
  skill?: SkillBinding; // 本次运行固定的 Skill 版本
  // —— 诊断审计与定向回流：由 AuditedDiagnosisEngine 注入 ——
  evidenceStore?: EvidenceStore; // 跨回流尝试共享的证据池（证据 ID 全局唯一）
  auditFeedback?: string[]; // 上轮独立审计的失败摘要，注入下一轮生成（去重反馈，避免重试重复犯错）
}

// ---------- 证据：每条证据必须自带"来源"，否则报告无法审计 ----------
// 证据 ID 由 EvidenceStore 在工具执行时签发；报告通过 evidenceId 精确关联，
// 模型不再负责复述原文、来源和行号（引用错位的根因就是让模型填这些字段）。

export interface CodeEvidenceRef {
  repoId: string;
  sha: string; // 采集时的完整 commit SHA
  path: string; // 相对路径（posix 分隔符）
  startLine: number; // 1-based
  endLine: number;
}

export interface BrowserEvidenceRef {
  channel: "page" | "network" | "console" | "screenshot";
  stepId?: string;
  url?: string;
}

export interface Evidence {
  evidenceId?: string; // EvidenceStore 签发的运行内唯一 ID（E1、E2…）
  source: string; // 从哪个日志/代码源、用什么查询条件拿到
  time?: number; // 日志条目时间（epoch ms）；代码/浏览器证据缺省
  level?: string; // 日志级别（ERROR / WARN / INFO ...）；其他证据缺省
  excerpt: string; // 截断后的原文片段（工具结果按不可信输入处理，必须限长）
  truncated?: boolean; // excerpt 是否被截断（模型与渲染层都应知道这不是全文）
  codeRef?: CodeEvidenceRef; // 代码证据的精确定位（系统填写）
  browserRef?: BrowserEvidenceRef; // 浏览器证据的来源（系统填写）
}

// ---------- 输出：结构化诊断报告 ----------
// 三个正交维度，不允许互相冒充：
//   status            = 材料完整性（想拿的材料都拿到了吗）
//   reproductionStatus = 异常是否复现（运行证据说了算，不由模型口头宣布）
//   hypotheses[].status = 定位状态（verified 必须有有效证据 + 复现确认，否则系统强制降级）

export type HypothesisStatus = "verified" | "supported" | "candidate" | "refuted";
export type ReproductionStatus = "reproduced" | "not_reproduced" | "indeterminate" | "blocked";

export interface RootCauseHypothesis {
  cause: string;
  confidence: "high" | "medium" | "low";
  evidence: Evidence[]; // 校验通过后由系统从 EvidenceStore 解析填充
  evidenceIds?: string[]; // 模型提交：引用的证据 ID（如 ["E12","E18"]）
  status?: HypothesisStatus; // 定位状态；最终值由报告校验裁定/修正
  pendingChecks?: string[]; // 还缺什么验证（待验证项）
}

export interface DiagnosisReport {
  status: "complete" | "partial"; // 材料完整性。partial 不许假装成功（skill 退出清单）
  hypotheses: RootCauseHypothesis[];
  suggestedNextSteps: string[];
  missingMaterial?: string[]; // partial 时：还缺什么材料
  reproductionStatus?: ReproductionStatus; // 异常是否已复现（独立于根因验证）
  corrections?: string[]; // 报告校验时系统施加的强制修正（审计用：模型说了不算的部分）
  audit?: AuditConclusion; // 独立审计结论（PASS/DEGRADE/REJECT 的落档，随报告一起回写工单）
}

// ---------- 独立审计（诊断审计与定向回流） ----------
// 第一原则：审计 Agent 不执行原任务，只挑战结果。价值在于"不同的目标函数、不同的上下文、
// 不同的工具权限"——一旦它开始替生成者干活，就失去了独立性。

// 审计维度（定稿范围）：复现有效性 + 归因充分性。引用正确性/版本一致性由 report-validator
// 的确定性检查负责，不属于审计 Agent 的职责。
export type AuditDimension = "reproduction_validity" | "attribution_sufficiency";
export type AuditVerdict = "pass" | "degrade" | "reject";

// 程序可执行的回流方向（按问题类型定向，不盲目重试）
export type ReflowTarget = "supplement_evidence" | "revise_hypothesis" | "downgrade_report";

export interface AuditIssue {
  dimension: AuditDimension;
  description: string;
  evidenceRef?: string; // 证据 ID 或轨迹引用，供人工核对
  hypothesisIndex?: number; // 指向报告中假设的下标（程序据此定向降级）
  reflowTarget: ReflowTarget; // 审计建议的回流方向；程序校验后执行
}

export interface AuditConclusion {
  verdict: AuditVerdict;
  issues: AuditIssue[];
  summary?: string;
}

// 审计输入包（刻意裁剪）：原始工单 + 待审报告 + 工具轨迹摘要 + 全部证据。
// 不含生成者的完整中间推理——让审计基于结果倒推合理性，而不是沿着生成者的思路走一遍。
export interface AuditInput {
  task: TicketTask;
  report: DiagnosisReport;
  observations: QueryObservation[]; // 工具轨迹（观察级摘要，含失败留痕）
  evidence: Evidence[]; // 本次运行全部证据（含未被引用的）
  skill?: SkillBinding;
}

// 审计 Agent 端口（形态二：独立 Auditor）。实现：fake-auditor.ts（确定性）/ pi-auditor.ts（SDK）。
export interface DiagnosisAuditor {
  audit(input: AuditInput, signal: AbortSignal): Promise<AuditConclusion>;
}

// ---------- 日志端口 ----------

export interface LogQueryIntent {
  service: string;
  timeWindow: { from: number; to: number }; // epoch ms
  keywords: string[]; // 任一命中即保留；为空 = 不过滤
}

export interface LogEntry {
  time: number;
  level: string;
  message: string;
}

// 日志源端口：本地样例文件 / 真实日志平台（SLS/ELK）适配器。
// name 参与证据 provenance 的生成，所以是接口的一部分。
export interface LogSource {
  readonly name: string;
  query(intent: LogQueryIntent, signal: AbortSignal): Promise<LogEntry[]>;
}

// ---------- 代码源端口（"看代码排错"定位能力的第二材料源） ----------
// 与 LogSource 同构：模型通过 search_code / read_code 两个工具提出意图，CodeSource 机械执行。
// 只读约束落在适配器实现里（路径白名单、限长），Core 只约定数据形状。
// repoId / revision 由实现暴露：证据登记时必须记录"读的是哪个仓的哪个版本"。

export interface CodeSearchIntent {
  pattern: string; // 大小写敏感的子串匹配（类名 / 方法名 / 异常信息片段）
  glob?: string; // 相对路径子串过滤（如 ".java"），不是通配符
  repoId?: string; // 多仓时必填（单仓实现可忽略）
}

export interface CodeReadIntent {
  path: string; // 相对代码根目录的路径
  startLine?: number; // 1-based，默认 1
  endLine?: number; // 含端点；缺省受单次读取上限约束
  repoId?: string;
}

export interface CodeSnippet {
  path: string; // 相对路径（posix 分隔符），代码证据 codeRef 的依据
  line: number; // 1-based 行号
  text: string;
}

export interface CodeSource {
  readonly name: string;
  readonly repoId?: string; // 多仓路由用；单仓实现缺省
  readonly revision?: string; // 解析后的完整 commit SHA（版本一致性的核对基准）
  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
  read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
}

// ---------- 浏览器复现端口（"复现驱动定位"的运行取证源） ----------
// 模型只生成受约束的操作计划（白名单动作），由执行器转成 Playwright 操作。
// 不允许模型生成并执行任意脚本；凭证与数据库隔离由环境配置负责，不进计划。

export type BrowserAction =
  | { action: "goto"; url: string }
  | { action: "reload" }
  | { action: "fill"; selector: string; text: string }
  | { action: "click"; selector: string }
  | { action: "press"; key: string }
  | { action: "wait"; selector?: string; timeoutMs?: number }
  | { action: "assert_visible"; selector: string }
  | { action: "assert_text"; selector: string; expected: string; comparison?: "contains" | "equals" };

export interface ReproductionStep {
  stepId: string;
  label?: string; // 人话描述（如：填写"详细地址"），进报告轨迹
  action: BrowserAction;
}

export interface ReproductionPlan {
  entryUrl: string;
  steps: ReproductionStep[];
}

export interface NetworkExchange {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  requestBody?: string; // 已截断
  responseBody?: string; // 已截断
  contentType?: string;
}

export interface BrowserStepResult {
  stepId: string;
  action: string; // action 名（如 click）
  label?: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  detail?: string; // 断言差异等补充信息
}

export interface BrowserRunResult {
  execution: "completed" | "failed" | "blocked"; // 执行状态：跑没跑完、是否环境阻塞
  reproduction: "reproduced" | "not_reproduced" | "indeterminate"; // 复现状态：业务断言结果
  steps: BrowserStepResult[];
  consoleErrors: string[]; // 已截断
  requests: NetworkExchange[]; // 已截断
  artifacts?: string[]; // trace / 截图位置
}

// 浏览器驱动端口：真实实现包 Playwright；测试用脚本化假驱动。
// 浏览器 context 能隔离 Cookie，隔离不了后端数据库——测试数据批次由环境配置负责。
export interface BrowserDriver {
  readonly name: string;
  execute(plan: ReproductionPlan, signal: AbortSignal): Promise<BrowserRunResult>;
  dispose?(): Promise<void>;
}

// 浏览器观察的结论摘要（observation_added 事件里跟在 browser 观察后面）
export interface BrowserObservationOutcome {
  execution: BrowserRunResult["execution"];
  reproduction: BrowserRunResult["reproduction"];
  steps: BrowserStepResult[];
  requestCount: number;
  consoleErrorCount: number;
}

// ---------- 工具意图与决策 ----------

export interface BrowserCheckIntent extends ReproductionPlan {}

export type Decision =
  | { kind: "call_tool"; name: "query_logs"; arguments: LogQueryIntent }
  | { kind: "call_tool"; name: "search_code"; arguments: CodeSearchIntent }
  | { kind: "call_tool"; name: "read_code"; arguments: CodeReadIntent }
  | { kind: "call_tool"; name: "run_browser_check"; arguments: BrowserCheckIntent }
  | { kind: "respond"; report: DiagnosisReport };

// 一次查询留下的观察记录（observation_added 事件的 payload）。
// kind 是判别字段：logs = 日志查询，code_search / code_read = 代码查询，
// browser = 浏览器复现（执行状态与复现状态分开记录）。
export type QueryObservation =
  | {
      kind: "logs";
      intent: LogQueryIntent;
      status: "success" | "error";
      evidence: Evidence[];
      error?: string;
    }
  | {
      kind: "code_search";
      intent: CodeSearchIntent;
      status: "success" | "error";
      evidence: Evidence[];
      error?: string;
    }
  | {
      kind: "code_read";
      intent: CodeReadIntent;
      status: "success" | "error";
      evidence: Evidence[];
      error?: string;
    }
  | {
      kind: "browser";
      intent: BrowserCheckIntent;
      status: "success" | "error";
      evidence: Evidence[];
      error?: string;
      outcome?: BrowserObservationOutcome;
    };

// ---------- 产品级事件（skill 的 AgentEvent 裁剪到本产品需要的子集） ----------
// 裁剪原则：每个类型都必须能连到本产品的任务/决策/证据/终态，否则不进（防过早抽象）。

export type RunErrorCode =
  | "budget_iterations" // 超过最大迭代数：反复调工具不收敛
  | "budget_tools" // 超过工具调用次数上限
  | "budget_timeout" // 超过时间预算：日志平台慢或模型卡住
  | "no_progress" // 空转守卫：一轮下来与上一轮进展完全相同
  | "rate_limited" // 模型/日志平台限流（可重试类，由适配器归一）
  | "timeout" // 单次调用超时（可重试类）
  | "auth" // 凭证问题（不可重试）
  | "invalid_tool" // 工具参数不合法（不可重试）
  | "provider_unavailable" // 模型服务不可用（可重试类）
  | "runtime_error"; // 其余未分类错误

export type AgentEvent =
  | { type: "run_started"; runId: string; sequence: number; timestamp: number }
  | {
      type: "skill_selected";
      runId: string;
      sequence: number;
      skill: SkillBinding;
      timestamp: number;
    }
  | { type: "decision_made"; runId: string; sequence: number; decision: Decision; timestamp: number }
  | {
      type: "tool_started";
      runId: string;
      sequence: number;
      toolCallId: string;
      toolName: string;
      timestamp: number;
    }
  | {
      type: "tool_completed";
      runId: string;
      sequence: number;
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      result?: unknown;
      error?: { code: string; message: string };
      durationMs: number;
      timestamp: number;
    }
  | {
      type: "observation_added";
      runId: string;
      sequence: number;
      name: string;
      observation: QueryObservation;
      timestamp: number;
    }
  | {
      type: "usage_reported";
      runId: string;
      sequence: number;
      usage: {
        inputTokens?: number; // deepseek 路径可能缺失，成本栏要容忍
        outputTokens?: number;
        toolCalls: number;
        durationMs: number;
        model?: string;
      };
      timestamp: number;
    }
  | {
      type: "audit_completed";
      runId: string;
      sequence: number;
      attempt: number; // 第几次生成尝试的审计（1 起）
      conclusion: AuditConclusion;
      timestamp: number;
    }
  | {
      type: "reflow_triggered";
      runId: string;
      sequence: number;
      attempt: number; // 被打回的尝试
      targets: ReflowTarget[]; // 程序按审计问题类型定向选择的回流方向
      reasons: string[]; // 人话原因（进事件流供审计）
      timestamp: number;
    }
  | {
      type: "run_completed";
      runId: string;
      sequence: number;
      status: "complete" | "partial";
      result: DiagnosisReport;
      missingMaterial?: string[];
      timestamp: number;
    }
  | {
      type: "run_failed";
      runId: string;
      sequence: number;
      error: { code: RunErrorCode; message: string };
      timestamp: number;
    }
  | { type: "run_cancelled"; runId: string; sequence: number; timestamp: number };

// ---------- 诊断引擎端口：驱动"最小循环"的角色 ----------
//
// fake / real 实现同一个接口、产出同一种事件流，golden transcript 对比才有锚点。
// context 必传：runId 由 Runtime 生成（评测对照的前提），引擎不得自行计算。
// signal 是必传参数（skill「Budgets and termination」）：取消必须能穿透到引擎内部。

export interface DiagnosisEngine {
  run(task: TicketTask, signal: AbortSignal, context: RunContext): AsyncIterable<AgentEvent>;
}
