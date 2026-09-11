// 工单预检 Agent（ticket-doctor）的领域契约 —— Core 层。
//
// 铁律（对应 skill「Agent Core & Runtime」）：这个文件不允许 import 任何 SDK。
// Core 只回答一个问题："一次合法的 bug 诊断运行是什么意思？"
// 循环由谁驱动（阶段1的假引擎 / 阶段2的 Pi SDK 适配器）、日志从哪来（本地样例 / 真实日志平台），
// 都属于适配器，通过下面的端口（LogSource / DiagnosisEngine）接进来。

// ---------- 输入：一张 bug 工单（对应 skill 的 Task） ----------

export interface TicketTask {
  ticketId: string; // 幂等键：同一张工单只诊断一次（阶段 3 的 Runtime 负责检查）
  title: string;
  description: string;
  service?: string; // 所属服务，决定日志检索范围
  occurredAt?: number; // 发生时间（epoch ms），决定日志时间窗
  commit?: string; // 提测提供的代码版本（commit 哈希/可解析引用）：决定 CodeSource 钉在哪个版本；缺省不给代码工具
}

// ---------- 证据：每条证据必须自带"来源"，否则报告无法审计 ----------
// 对应 skill「Adapter anchoring」踩坑记录 3：工具结果不带 provenance 是真实事故，
// 所以证据的 provenance 是字段，不是附件。

export interface Evidence {
  source: string; // 从哪个日志/代码源、用什么查询条件拿到（unverified 前缀 = 模型引用未命中，见反编造核验）
  time?: number; // 日志条目时间（epoch ms）；代码证据没有时间，缺省
  level?: string; // 日志级别（ERROR / WARN / INFO ...）；代码证据缺省
  excerpt: string; // 截断后的原文片段（工具结果按不可信输入处理，必须限长）
}

// ---------- 输出：结构化诊断报告 ----------

export interface RootCauseHypothesis {
  cause: string;
  confidence: "high" | "medium" | "low";
  evidence: Evidence[]; // 每个假设必须挂证据，禁止空口断言
}

export interface DiagnosisReport {
  status: "complete" | "partial";
  hypotheses: RootCauseHypothesis[];
  suggestedNextSteps: string[];
  missingMaterial?: string[]; // partial 时：还缺什么材料。partial 不许假装成功（skill 退出清单）
}

// ---------- 工具意图与日志端口 ----------

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

// 日志源端口：阶段 1 = 本地样例文件；阶段 4 = 真实日志平台（SLS/ELK）适配器。
// name 参与证据 provenance 的生成，所以是接口的一部分。
export interface LogSource {
  readonly name: string;
  query(intent: LogQueryIntent, signal: AbortSignal): Promise<LogEntry[]>;
}

// ---------- 代码源端口（"看代码排错"定位能力的第二材料源） ----------
// 与 LogSource 同构：模型通过 search_code / read_code 两个工具提出意图，CodeSource 机械执行。
// 只读约束落在适配器实现里（路径白名单、限长），Core 只约定数据形状。

export interface CodeSearchIntent {
  pattern: string; // 大小写敏感的子串匹配（类名 / 方法名 / 异常信息片段）
  glob?: string; // 相对路径子串过滤（如 ".java"），不是通配符
}

export interface CodeReadIntent {
  path: string; // 相对代码根目录的路径
  startLine?: number; // 1-based，默认 1
  endLine?: number; // 含端点；缺省受单次读取上限约束
}

export interface CodeSnippet {
  path: string; // 相对路径（posix 分隔符），模型引用代码时填 location 的依据
  line: number; // 1-based 行号
  text: string;
}

export interface CodeSource {
  readonly name: string;
  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
  read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]>;
}

// ---------- 决策（对应 skill 的 Decision；本产品 v1 没有 ask_human） ----------

export type Decision =
  | { kind: "call_tool"; name: "query_logs"; arguments: LogQueryIntent }
  | { kind: "call_tool"; name: "search_code"; arguments: CodeSearchIntent }
  | { kind: "call_tool"; name: "read_code"; arguments: CodeReadIntent }
  | { kind: "respond"; report: DiagnosisReport };

// 一次查询留下的观察记录（observation_added 事件的 payload）。
// kind 是判别字段：logs = 日志查询，code_search / code_read = 代码查询（"看代码排错"延伸）。
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
    };

// ---------- 产品级事件（skill 的 AgentEvent 裁剪到本产品需要的子集） ----------
// 裁剪原则：每个类型都必须能连到本产品的任务/决策/证据/终态，否则不进（防过早抽象）。
// 相对 skill 最小契约：去掉 human_input_requested/received、run_resumed（v1 全自动）、
// model_requested（模型信息在 usage_reported.model 里）。

export type RunErrorCode =
  | "budget_iterations" // 超过最大迭代数：反复调工具不收敛
  | "budget_tools" // 超过工具调用次数上限
  | "budget_timeout" // 超过时间预算：日志平台慢或模型卡住
  | "no_progress" // 空转守卫：一轮下来与上一轮进展完全相同
  | "rate_limited" // 模型/日志平台限流（可重试类，阶段 2 由适配器归一）
  | "timeout" // 单次调用超时（可重试类）
  | "auth" // 凭证问题（不可重试）
  | "invalid_tool" // 工具参数不合法（不可重试）
  | "provider_unavailable" // 模型服务不可用（可重试类）
  | "runtime_error"; // 其余未分类错误

export type AgentEvent =
  | { type: "run_started"; runId: string; sequence: number; timestamp: number }
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
        inputTokens?: number; // deepseek 路径可能缺失（skill verification-log 已知缺口），成本栏要容忍
        outputTokens?: number;
        toolCalls: number;
        durationMs: number;
        model?: string;
      };
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
// 这是 fake/real 语义一致性的锚点：阶段 1 的 FakeDiagnosisEngine 和阶段 2 的 Pi SDK 适配器
// 实现同一个接口、产出同一种事件流，golden transcript 对比才有意义。
// signal 是必传参数（skill「Budgets and termination」）：取消必须能穿透到引擎内部。

export interface DiagnosisEngine {
  run(task: TicketTask, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
