// 阶段 2/4：DiagnosisEngine 的真实实现 —— Pi Agent SDK 被关在这唯一的文件里。
// 写法依据：src/ticket-doctor/ADAPTER-NOTES.md（映射笔记，先于本文件完成）+ SDK 0.84.2 源码。
// 铁律：SDK 的类型和事件不出本文件；对上层只暴露 contracts.ts 的产品事件。
//
// 材料源：query_logs（LogSource）+ search_code/read_code（CodeSource，运行钉死版本）
//        + run_browser_check（BrowserRunner，工单有页面入口且配置了驱动才启用）。
// 证据约束交付：工具执行时证据登记进 EvidenceStore 并签发 ID；submit_report 只引用 ID，
// 报告校验器（report-validator.ts）负责引用真实性与强制降级——不再用字符串匹配反编造
// （相同片段命中多个文件时字符串匹配会关联错位，这是已被识别的结构性问题）。

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentEvent,
  BrowserDriver,
  CodeReadIntent,
  CodeSearchIntent,
  CodeSource,
  Decision,
  DiagnosisEngine,
  Evidence,
  LogSource,
  QueryObservation,
  RunContext,
  TicketTask,
} from "./contracts.ts";
import { BrowserRunner } from "./browser-runner.ts";
import type { MultiRepoCodeSource } from "./code-sources.ts";
import { EvidenceStore } from "./evidence-store.ts";
import { validateReportDraft, type ReportDraft } from "./report-validator.ts";

// ---------- 默认诊断提示词 ----------
// 对抗 skill verification-log「观察 1」（模型跳过工具直接作答）：结论必须挂在证据 ID 上。
// 日志不再强制第一步（复现驱动定位：按问题选源码检索或浏览器复现，用运行证据调整方向）；
// status 判定仍是硬规则（2026-09-06 真机方差修正条款），并由报告校验器系统兜底。
const DEFAULT_SYSTEM_PROMPT = `你是 bug 工单的预检诊断员，产出供接手开发参考的初步根因分析。
规则：
1. 按问题选材料：需要代码定位就用 search_code / read_code；需要运行证据就用 query_logs 或
   run_browser_check（若启用）。日志是按需证据源，不强制第一步；禁止不做任何查询就凭空分析。
2. 证据引用是硬规则：submit_report 里每条假设只能用 evidenceIds 引用工具结果中给出的证据
   编号（形如 [E12]）。系统会把编号解析成原文、来源与位置——禁止自己编造编号、来源或行号。
3. status（材料完整性）判定是硬规则，必须逐条对照：
   - 只要你尝试获取过某份材料但没有成功拿到（查询报错、数据源不存在、无法核实你认为关键的
     环节），status 必须是 partial，且 missingMaterial 逐项列出缺失材料及原因；
   - 查询成功但结果为空不算缺失（那是有效结论）；只有"想要但拿不到"才构成缺失；
   - 禁止把"缺失说明"写进假设正文来代替 partial + missingMaterial。
4. reproductionStatus 只能描述 run_browser_check 的真实结果；没有执行过复现就不许说 reproduced。
5. 定位状态分级：verified（根因已验证，需要有效证据 + 复现确认）、supported（有证据支持）、
   candidate（候选原因）。证据不足时降级为 candidate，并把"还缺什么"写进 pendingChecks。
6. 绝不编造；置信度必须反映证据的强度，而不是你行文的确定语气。
7. 报告必须通过 submit_report 工具提交，不要用普通文本回复代替提交。`;

// 工单带代码版本时追加的代码工具规则（版本已在运行开始时解析成完整 SHA 并钉死）
const CODE_TOOL_RULES = `
代码材料规则（本工单提供了代码版本，search_code / read_code 已启用）：
- search_code：按子串定位代码；read_code：按行查看文件内容。多仓时用 repoId 指定仓库。
- 先用日志/堆栈里的类名、方法名做 search_code，再用 read_code 核实上下文。
- 代码里找不到工单描述的位置时如实说明，不得臆测文件内容。`;

// 配置了浏览器驱动时追加的复现规则
const BROWSER_TOOL_RULES = `
浏览器复现规则（run_browser_check 已启用）：
- 你只能提交受约束的操作计划（goto/reload/fill/click/press/wait/assert_visible/assert_text），
  由执行器转成浏览器操作；不允许任何脚本执行。
- 先参考工单的 reproductionSteps 生成计划，再用 assert_text / assert_visible 表达业务断言。
- 执行状态（跑没跑完）与复现状态（业务断言是否复现异常）是两回事："找不到按钮"是执行失败，
  不等于没有 Bug。执行失败时照实记录，不要把执行失败当根因，也不要当"未复现"。`;

// ---------- submit_report 的 schema：报告形状由 TypeBox 强制，不解析自由文本 ----------
const reportSchema = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial")], {
    description:
      "complete 仅当依赖的全部材料都成功获取且假设完全建立在已获取材料上；任何一次获取失败或关键材料缺失都必须选 partial",
  }),
  reproductionStatus: Type.Optional(
    Type.Union(
      [
        Type.Literal("reproduced"),
        Type.Literal("not_reproduced"),
        Type.Literal("indeterminate"),
        Type.Literal("blocked"),
      ],
      { description: "异常是否复现；只能依据 run_browser_check 的真实结果填写，未复现过就不填" },
    ),
  ),
  hypotheses: Type.Array(
    Type.Object({
      cause: Type.String({ description: "根因假设，一句话" }),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      evidenceIds: Type.Array(Type.String(), {
        description: "引用工具结果中形如 [E12] 的证据编号；系统负责解析原文与位置，禁止编造",
      }),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("verified"),
            Type.Literal("supported"),
            Type.Literal("candidate"),
            Type.Literal("refuted"),
          ],
          { description: "定位状态：verified 需要有效证据 + 复现确认，证据不足选 candidate" },
        ),
      ),
      pendingChecks: Type.Optional(
        Type.Array(Type.String(), { description: "还缺什么验证（待验证项），证据不足时必填" }),
      ),
    }),
  ),
  suggestedNextSteps: Type.Array(Type.String(), { description: "建议开发接手后的排查动作" }),
  missingMaterial: Type.Optional(
    Type.Array(Type.String(), {
      description: "status=partial 时必填：逐项列出缺失的材料及原因（查询成功但结果为空不算缺失）",
    }),
  ),
});
type ReportParams = Static<typeof reportSchema>;

// ---------- query_logs 的 schema ----------
const queryLogsSchema = Type.Object({
  service: Type.String({ description: "要查询的服务名" }),
  from: Type.String({ description: "起始时间，ISO8601，如 2026-09-06T09:52:00+08:00" }),
  to: Type.String({ description: "结束时间，ISO8601" }),
  keywords: Type.Array(Type.String(), { description: "关键词列表，任一命中即保留" }),
});
type QueryLogsParams = Static<typeof queryLogsSchema>;

// ---------- search_code / read_code 的 schema ----------
const searchCodeSchema = Type.Object({
  pattern: Type.String({ description: "大小写敏感的子串：类名/方法名/异常信息片段" }),
  glob: Type.Optional(Type.String({ description: "路径子串过滤，如 .java" })),
  repoId: Type.Optional(Type.String({ description: "多仓时指定仓库；单仓可省略" })),
});
type SearchCodeParams = Static<typeof searchCodeSchema>;

const readCodeSchema = Type.Object({
  path: Type.String({ description: "相对代码根目录的文件路径，用 / 分隔" }),
  startLine: Type.Optional(Type.Number({ description: "起始行，1-based，默认 1" })),
  endLine: Type.Optional(Type.Number({ description: "结束行（含），默认起始行+199" })),
  repoId: Type.Optional(Type.String()),
});
type ReadCodeParams = Static<typeof readCodeSchema>;

// ---------- run_browser_check 的 schema（宽松：严格校验在 BrowserRunner.validatePlan） ----------
const browserCheckSchema = Type.Object({
  entryUrl: Type.String({ description: "页面入口 URL" }),
  steps: Type.Array(
    Type.Object({
      stepId: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ description: "这步在做什么（人话）" })),
      action: Type.Object({
        action: Type.String({
          description: "goto | reload | fill | click | press | wait | assert_visible | assert_text",
        }),
        url: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
        expected: Type.Optional(Type.String()),
        comparison: Type.Optional(Type.Union([Type.Literal("contains"), Type.Literal("equals")])),
      }),
    }),
    { description: "受约束的操作步骤；最后用 assert_* 表达业务断言" },
  ),
});
type BrowserCheckParams = Static<typeof browserCheckSchema>;

export interface PiDiagnosisOptions {
  logSource: LogSource;
  codeSource?:
    | CodeSource // 固定代码源（整个服务共用一个版本）
    | ((
        task: TicketTask,
        context: RunContext,
      ) => CodeSource | undefined | Promise<CodeSource | undefined>); // 按工单/上下文解析：create() 已把 SHA 钉死
  browserDriver?: BrowserDriver; // 配置后 run_browser_check 启用（前提：工单有页面入口）
  provider?: string; // 默认 "deepseek"
  modelId?: string; // 默认 "deepseek-v4-flash"（内置目录见 deepseek.json）
  apiKey?: string; // 不传则依赖环境变量发现（DEEPSEEK_API_KEY）
  maxIterations?: number; // query_logs 最多发起次数，默认 6
  maxCodeReads?: number; // search_code + read_code 合计上限，默认 10（budget_tools）
  maxBrowserRuns?: number; // run_browser_check 最多发起次数，默认 2
  maxReportRevisions?: number; // 报告校验打回后的修订上限，超过即接受强制降级版，默认 2
  timeoutMs?: number; // 默认 120_000
  systemPrompt?: string;
}

// 诊断过程中的可变状态：工具闭包写，终态判定读
interface RunFlags {
  report?: DiagnosisReportForFlags;
  noProgress?: { message: string };
  budgetIterations?: { message: string };
  budgetTools?: { message: string };
  callerCancelled: boolean;
  timedOut: boolean;
}

// 避免 DiagnosisReport 类型在本文件顶部多一个 import 的别名（内容同 contracts）
type DiagnosisReportForFlags = import("./contracts.ts").DiagnosisReport;

// 把模型提交的报告草稿校验并补全证据（不命中 = 打回或强制降级）
function codeTargetOf(codeSource: CodeSource, repoId?: string): CodeSource {
  const multi = codeSource as MultiRepoCodeSource;
  if (typeof multi.pick === "function") {
    return multi.pick(repoId);
  }
  return codeSource;
}
// 把工单渲染成给模型看的第一条 user 消息
function renderTicketContext(task: TicketTask): string {
  const lines = [
    `工单号：${task.ticketId}`,
    `标题：${task.title}`,
    `描述：${task.description}`,
    task.service ? `所属服务：${task.service}` : "所属服务：未知（请自行判断该查什么）",
    task.occurredAt ? `发生时间：${new Date(task.occurredAt).toISOString()}` : "发生时间：未知",
  ];
  if (task.entryUrl) lines.push(`页面入口：${task.entryUrl}`);
  if (task.expectedBehavior) lines.push(`预期行为：${task.expectedBehavior}`);
  if (task.actualBehavior) lines.push(`实际行为：${task.actualBehavior}`);
  if (task.reproductionSteps && task.reproductionSteps.length > 0) {
    lines.push("复现步骤（用户描述）：");
    for (const step of task.reproductionSteps) lines.push(`  - ${step}`);
  }
  if (task.repositories && task.repositories.length > 0) {
    lines.push(
      `仓库版本：${task.repositories.map((r) => `${r.repoId}=${r.rev ?? "HEAD"}`).join(", ")}`,
    );
  }
  if (task.commit) {
    lines.push(`代码版本：${task.commit}（search_code / read_code 已启用，只能查看该版本）`);
  } else if (!task.repositories || task.repositories.length === 0) {
    lines.push("代码版本：未提供（代码工具未启用；若需要代码定位，请在 missingMaterial 中说明缺代码版本）");
  }
  lines.push("");
  lines.push("请按系统提示完成预检诊断：按需查询材料，最后用 submit_report 提交报告。");
  return lines.join("\n");
}

// SDK 工具调用参数（模型产出）→ 产品决策（ADAPTER-NOTES §2 归一化表）
function buildDecisionFromToolCall(toolName: string, args: unknown): Decision | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "query_logs":
      return {
        kind: "call_tool",
        name: "query_logs",
        arguments: {
          service: String(a.service ?? ""),
          timeWindow: {
            from: Date.parse(String(a.from ?? "")) || 0,
            to: Date.parse(String(a.to ?? "")) || 0,
          },
          keywords: Array.isArray(a.keywords) ? (a.keywords as string[]) : [],
        },
      };
    case "search_code":
      return {
        kind: "call_tool",
        name: "search_code",
        arguments: {
          pattern: String(a.pattern ?? ""),
          ...(typeof a.glob === "string" ? { glob: a.glob } : {}),
          ...(typeof a.repoId === "string" ? { repoId: a.repoId } : {}),
        },
      };
    case "read_code":
      return {
        kind: "call_tool",
        name: "read_code",
        arguments: {
          path: String(a.path ?? ""),
          ...(typeof a.startLine === "number" ? { startLine: a.startLine } : {}),
          ...(typeof a.endLine === "number" ? { endLine: a.endLine } : {}),
          ...(typeof a.repoId === "string" ? { repoId: a.repoId } : {}),
        },
      };
    case "run_browser_check": {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      return {
        kind: "call_tool",
        name: "run_browser_check",
        arguments: {
          entryUrl: String(a.entryUrl ?? ""),
          steps: steps as import("./contracts.ts").BrowserCheckIntent["steps"],
        },
      };
    }
    default:
      return undefined; // 未知工具不产生产品决策
  }
}

// 从 SDK 工具失败结果里提取人话错误信息（content: [{type:"text",text}]）
function extractErrorText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts.join("\n").slice(0, 500) : undefined;
}

export class PiDiagnosisEngine {
  private readonly logSource: LogSource;
  private readonly codeSourceSpec?: PiDiagnosisOptions["codeSource"];
  private readonly browserDriver?: BrowserDriver;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly apiKey?: string;
  private readonly maxIterations: number;
  private readonly maxCodeReads: number;
  private readonly maxBrowserRuns: number;
  private readonly maxReportRevisions: number;
  private readonly timeoutMs: number;
  private readonly systemPrompt?: string;

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(opts: PiDiagnosisOptions) {
    this.logSource = opts.logSource;
    this.codeSourceSpec = opts.codeSource;
    this.browserDriver = opts.browserDriver;
    this.provider = opts.provider ?? "deepseek";
    this.modelId = opts.modelId ?? "deepseek-v4-flash";
    this.apiKey = opts.apiKey;
    this.maxIterations = opts.maxIterations ?? 6;
    this.maxCodeReads = opts.maxCodeReads ?? 10;
    this.maxBrowserRuns = opts.maxBrowserRuns ?? 2;
    this.maxReportRevisions = opts.maxReportRevisions ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.systemPrompt = opts.systemPrompt;
  }

  async *run(task: TicketTask, signal: AbortSignal, context: RunContext): AsyncGenerator<AgentEvent> {
    // runId 由 Runtime 生成并传入（评测对照的前提）；引擎不自行计算
    const runId = context.runId;
    let seq = 0;
    let queryCalls = 0;
    let codeCalls = 0;
    let browserCalls = 0;
    let toolFailureCount = 0;
    let reportRevisions = 0;
    let browserReproduced = false;
    const startedAt = Date.now();
    const now = () => Date.now();

    yield { type: "run_started", runId, sequence: ++seq, timestamp: now() };

    // Skill 版本在运行开始时已由调用方固定（skill_selected 进事件流，可追溯到内容哈希）
    if (context.skill) {
      yield {
        type: "skill_selected",
        runId,
        sequence: ++seq,
        skill: context.skill,
        timestamp: now(),
      };
    }

    // 按工单/上下文解析代码源：解析发生在 run 开始（SHA 在此刻钉死）。
    // 工厂函数与固定实例两种形态都支持。
    const codeSource = this.codeSourceSpec
      ? typeof this.codeSourceSpec === "function"
        ? await this.codeSourceSpec(task, context)
        : this.codeSourceSpec
      : undefined;

    const flags: RunFlags = { callerCancelled: false, timedOut: false };
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let promptError: unknown;
    // 终态原料：声明在 try 外，终态判定在 finally 之后
    let stopReason: string | undefined;
    let usageInput: number | undefined;
    let usageOutput: number | undefined;

    // 调用方取消与超时必须可区分（终态分别是 run_cancelled / budget_timeout）
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener("abort", () => {
      flags.callerCancelled = true;
    }, { once: true });
    timeoutSignal.addEventListener("abort", () => {
      flags.timedOut = true;
    }, { once: true });
    const composed = AbortSignal.any([signal, timeoutSignal]);

    // 证据登记（ID 由这里签发）+ 工具观察（按 toolCallId 存：真机见过并行工具调用）
    const evidenceStore = new EvidenceStore(runId);
    const observationByCallId = new Map<string, QueryObservation>();
    let lastQueryKey: string | null = null; // 空转守卫用：上次日志查询的指纹
    const browserRunner = this.browserDriver
      ? new BrowserRunner({ driver: this.browserDriver })
      : undefined;
    const browserEnabled = browserRunner !== undefined && typeof task.entryUrl === "string";

    // 代码工具共用：把 snippets 登记进证据池（带 repoId@sha 的精确 codeRef）并生成带 ID 的返回文本
    function registerCodeSnippets(
      toolCallId: string,
      kind: "code_search" | "code_read",
      intent: CodeSearchIntent | CodeReadIntent,
      target: CodeSource,
      snippets: Array<{ path: string; line: number; text: string }>,
      render: (s: { path: string; line: number; text: string }) => string,
    ): { content: Array<{ type: "text"; text: string }>; details: Record<string, number> } {
      const evidence: Evidence[] = [];
      const lines: string[] = [];
      const repoId = target.repoId ?? "app";
      const sha = target.revision; // create() 已在运行开始时解析；未解析时不挂 codeRef（校验器跳过版本核对）
      for (const s of snippets) {
        const stored = evidenceStore.register({
          kind: "code",
          toolCallId,
          excerpt: s.text,
          ...(sha
            ? {
                codeRef: {
                  repoId,
                  sha,
                  path: s.path,
                  startLine: s.line,
                  endLine: s.line,
                },
              }
            : {}),
        });
        evidence.push({
          evidenceId: stored.evidenceId,
          source: stored.source,
          excerpt: stored.excerpt,
          truncated: stored.truncated,
          codeRef: stored.codeRef,
        });
        lines.push(`[${stored.evidenceId}] ${render(s)}`);
      }
      const observation: QueryObservation =
        kind === "code_search"
          ? { kind: "code_search", intent: intent as CodeSearchIntent, status: "success", evidence }
          : { kind: "code_read", intent: intent as CodeReadIntent, status: "success", evidence };
      observationByCallId.set(toolCallId, observation);
      return {
        content: [
          {
            type: "text",
            text:
              snippets.length > 0
                ? lines.join("\n")
                : kind === "code_search"
                  ? "（没有匹配的代码行）"
                  : "（文件为空或行号超出范围）",
          },
        ],
        details: kind === "code_search" ? { matches: snippets.length } : { lines: snippets.length },
      };
    }

    try {
      // ---- SDK 组装：example 12「全手动」模式，无任何文件发现 ----
      const agentDir = join(tmpdir(), "pi-ticket-doctor");
      mkdirSync(agentDir, { recursive: true });

      const modelRuntime = await ModelRuntime.create();
      if (this.apiKey) {
        await modelRuntime.setRuntimeApiKey(this.provider, this.apiKey);
      }
      // getBuiltinModel 泛型要求字面量：动态值收窄 cast，运行时以 undefined 检查兜底
      const model = getBuiltinModel(
        this.provider as "deepseek",
        this.modelId as "deepseek-v4-flash",
      );
      if (!model) {
        throw new Error(`内置目录里找不到模型：${this.provider}/${this.modelId}`);
      }

      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), // Skill 不走 SDK 文件发现：版本与哈希由 RunContext 固定
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () =>
          (this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) +
          (codeSource ? CODE_TOOL_RULES : "") +
          (browserEnabled ? BROWSER_TOOL_RULES : "") +
          (context.skill ? `\n===== 诊断 Skill（${context.skill.id}@${context.skill.version}）=====\n${context.skill.body}` : "") +
          // 预算透明化（2026-09-06 真机治理）：模型知道预算才会规划着花，而不是被硬刹车掐死在半路
          `\n预算（硬上限，无法申请追加）：query_logs 最多 ${this.maxIterations} 次；search_code / read_code 合计最多 ${this.maxCodeReads} 次${browserEnabled ? `；run_browser_check 最多 ${this.maxBrowserRuns} 次` : ""}。请规划查询，并在预算内务必提交报告。`,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };

      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });

      // sessionRef 让工具 execute 能触发 abort（空转/预算路径）
      let sessionRef: AgentSession | undefined;

      const queryLogsTool = defineTool({
        name: "query_logs",
        label: "query_logs",
        description: "查询指定服务在时间窗内的错误日志。返回带证据编号（[E#]）的日志原文。",
        parameters: queryLogsSchema,
        execute: async (toolCallId, params: QueryLogsParams, toolSignal) => {
          const from = Date.parse(params.from);
          const to = Date.parse(params.to);
          if (Number.isNaN(from) || Number.isNaN(to)) {
            throw new Error("from/to 必须是可解析的 ISO8601 时间字符串");
          }
          const intent = {
            service: params.service,
            timeWindow: { from, to },
            keywords: params.keywords,
          };

          // 空转守卫：与上一次查询完全相同 = 原地打转 → 中止整个 run
          const key = JSON.stringify(intent);
          if (key === lastQueryKey) {
            flags.noProgress = { message: "query_logs 参数与上一次完全相同（空转），诊断终止" };
            sessionRef?.abort();
            throw new Error(flags.noProgress.message);
          }
          lastQueryKey = key;

          try {
            const entries = await this.logSource.query(intent, toolSignal ?? new AbortController().signal);
            const provenance = `${this.logSource.name} | keywords=[${params.keywords.join(",")}] | window=[${params.from} ~ ${params.to}]`;
            const evidence: Evidence[] = [];
            const lines: string[] = [];
            for (const e of entries) {
              const stored = evidenceStore.register({
                kind: "log",
                toolCallId,
                excerpt: e.message,
                source: provenance,
                time: e.time,
                level: e.level,
              });
              evidence.push({
                evidenceId: stored.evidenceId,
                source: stored.source,
                time: stored.time,
                level: stored.level,
                excerpt: stored.excerpt,
                truncated: stored.truncated,
              });
              lines.push(`[${stored.evidenceId}] ${new Date(e.time).toISOString()}\t${e.level}\t${stored.excerpt}`);
            }
            observationByCallId.set(toolCallId, {
              kind: "logs",
              intent,
              status: "success",
              evidence,
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    entries.length > 0
                      ? lines.join("\n")
                      : "（时间窗内没有匹配的日志条目）",
                },
              ],
              details: { count: entries.length },
            };
          } catch (err) {
            // 工具失败留痕：失败也要进观察记录，评测才能区分"Skill 判断错"和"工具没跑成"
            const message = err instanceof Error ? err.message : String(err);
            observationByCallId.set(toolCallId, {
              kind: "logs",
              intent,
              status: "error",
              evidence: [],
              error: message,
            });
            throw err;
          }
        },
      });

      const searchCodeTool = defineTool({
        name: "search_code",
        label: "search_code",
        description:
          "在工单指定版本的代码里按子串搜索（返回带证据编号的 文件:行号:内容）。用日志/堆栈里的类名、方法名定位代码。",
        parameters: searchCodeSchema,
        execute: async (toolCallId, params: SearchCodeParams, toolSignal) => {
          if (!codeSource) throw new Error("search_code 未启用：工单未提供代码版本");
          const target = codeTargetOf(codeSource, params.repoId);
          const intent: CodeSearchIntent = {
            pattern: params.pattern,
            ...(typeof params.glob === "string" ? { glob: params.glob } : {}),
            ...(typeof params.repoId === "string" ? { repoId: params.repoId } : {}),
          };
          try {
            const snippets = await target.search(intent, toolSignal ?? new AbortController().signal);
            return registerCodeSnippets(toolCallId, "code_search", intent, target, snippets, (s) => `${s.path}:${s.line}:${s.text}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            observationByCallId.set(toolCallId, {
              kind: "code_search",
              intent,
              status: "error",
              evidence: [],
              error: message,
            });
            throw err;
          }
        },
      });

      const readCodeTool = defineTool({
        name: "read_code",
        label: "read_code",
        description: "按行查看工单指定版本的源码文件内容（只读）。用于核实日志中出现的代码位置。",
        parameters: readCodeSchema,
        execute: async (toolCallId, params: ReadCodeParams, toolSignal) => {
          if (!codeSource) throw new Error("read_code 未启用：工单未提供代码版本");
          const target = codeTargetOf(codeSource, params.repoId);
          const intent: CodeReadIntent = {
            path: params.path,
            ...(typeof params.startLine === "number" ? { startLine: params.startLine } : {}),
            ...(typeof params.endLine === "number" ? { endLine: params.endLine } : {}),
            ...(typeof params.repoId === "string" ? { repoId: params.repoId } : {}),
          };
          try {
            const snippets = await target.read(intent, toolSignal ?? new AbortController().signal);
            return registerCodeSnippets(toolCallId, "code_read", intent, target, snippets, (s) => `${s.line}: ${s.text}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            observationByCallId.set(toolCallId, {
              kind: "code_read",
              intent,
              status: "error",
              evidence: [],
              error: message,
            });
            throw err;
          }
        },
      });

      const browserCheckTool = defineTool({
        name: "run_browser_check",
        label: "run_browser_check",
        description:
          "按受约束的操作计划在测试环境里复现问题：执行步骤、业务断言，并记录页面、网络与控制台证据（带证据编号）。",
        parameters: browserCheckSchema,
        execute: async (toolCallId, params: BrowserCheckParams, toolSignal) => {
          if (!browserRunner) throw new Error("run_browser_check 未启用：未配置浏览器驱动");
          if (typeof task.entryUrl !== "string") {
            throw new Error("run_browser_check 未启用：工单没有页面入口（entryUrl）");
          }
          const plan = { entryUrl: params.entryUrl, steps: params.steps };
          try {
            const { result, evidenceInputs } = await browserRunner.run(
              plan,
              toolSignal ?? new AbortController().signal,
            );
            const evidence: Evidence[] = [];
            for (const input of evidenceInputs) {
              const stored = evidenceStore.register({ ...input, toolCallId });
              evidence.push({
                evidenceId: stored.evidenceId,
                source: stored.source,
                excerpt: stored.excerpt,
                truncated: stored.truncated,
                browserRef: stored.browserRef,
              });
            }
            if (result.reproduction === "reproduced") {
              browserReproduced = true;
            }
            const outcome = {
              execution: result.execution,
              reproduction: result.reproduction,
              steps: result.steps,
              requestCount: result.requests.length,
              consoleErrorCount: result.consoleErrors.length,
            };
            observationByCallId.set(toolCallId, {
              kind: "browser",
              intent: plan,
              status: "success",
              evidence,
              outcome,
            });
            const stepLines = result.steps
              .map((s) => `- ${s.stepId} ${s.label ?? s.action}: ${s.status}${s.error ? `（${s.error}）` : ""}`)
              .join("\n");
            const evidenceLine = evidence.length > 0
              ? `\n取证：${evidence.map((e) => e.evidenceId).join(", ")}`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `执行状态：${result.execution}；复现状态：${result.reproduction}\n步骤：\n${stepLines}${evidenceLine}`,
                },
              ],
              details: outcome,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            observationByCallId.set(toolCallId, {
              kind: "browser",
              intent: plan,
              status: "error",
              evidence: [],
              error: message,
            });
            throw err;
          }
        },
      });

      const submitReportTool = defineTool({
        name: "submit_report",
        label: "submit_report",
        description:
          "提交最终诊断报告草稿。每条假设用 evidenceIds 引用工具结果中的证据编号（[E#]）；校验不通过会被打回，请按问题补证或降级。",
        parameters: reportSchema,
        execute: async (_toolCallId, params: ReportParams) => {
          const final = reportRevisions >= this.maxReportRevisions;
          const validation = validateReportDraft(params, {
            store: evidenceStore,
            context,
            toolFailureCount,
            browserReproduced,
            final,
          });
          if (validation.decision === "revise") {
            reportRevisions += 1;
            const issueText = validation.issues
              .map((i) => `- [${i.code}] ${i.message}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text:
                    `报告未通过校验，尚未提交。问题：\n${issueText}\n` +
                    "请重新 submit_report：改用真实存在的证据编号，或去掉无法核实的引用并把结论降级（candidate + pendingChecks）。",
                },
              ],
              details: { accepted: false, issues: validation.issues },
            };
          }
          flags.report = validation.report;
          return {
            content: [{ type: "text", text: "报告已通过校验，诊断结束。" }],
            details: {
              accepted: true,
              status: validation.report.status,
              corrections: validation.corrections.length,
            },
          };
        },
      });

      const customTools = browserEnabled
        ? [queryLogsTool, searchCodeTool, readCodeTool, browserCheckTool, submitReportTool]
        : codeSource
          ? [queryLogsTool, searchCodeTool, readCodeTool, submitReportTool]
          : [queryLogsTool, submitReportTool];

      const created = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        settingsManager,
        noTools: "builtin", // 禁掉 read/write/edit/bash：消费不可信工单内容的服务不给 bash
        customTools,
        sessionManager: SessionManager.inMemory(process.cwd()),
      });
      session = created.session;
      sessionRef = session;

      // ---- drain 循环：订阅 SDK 事件，归一化后逐个 yield（scenario-event-logging 的模式）----
      const pending: AgentSessionEvent[] = [];
      let settled = false;
      let promptDone = false;
      let wake: () => void = () => {};
      const waitForEvent = () => new Promise<void>((resolve) => {
        wake = resolve;
      });
      unsubscribe = session.subscribe((e) => {
        pending.push(e);
        wake();
      });

      const toolStarts = new Map<string, number>();

      composed.addEventListener("abort", () => {
        void session?.abort();
      }, { once: true });

      const promptPromise = session
        .prompt(renderTicketContext(task))
        .then(
          () => {
            promptDone = true;
            wake();
          },
          (err: unknown) => {
            promptError = err;
            promptDone = true;
            wake();
          },
        );

      while (true) {
        if (pending.length > 0) {
          const event = pending.shift()!;
          switch (event.type) {
            case "tool_execution_start": {
              if (event.toolName === "submit_report") break; // 等 end 时用完整报告发 respond 决策
              // 预算：日志 / 代码 / 浏览器分别计数（ADAPTER-NOTES §3.4/3.5）
              let budgetMessage: string | undefined;
              let budgetFlag: "budgetIterations" | "budgetTools" = "budgetTools";
              if (event.toolName === "query_logs") {
                queryCalls += 1;
                if (queryCalls > this.maxIterations) {
                  budgetMessage = `query_logs 发起次数超过上限 ${this.maxIterations}`;
                  budgetFlag = "budgetIterations";
                }
              } else if (event.toolName === "run_browser_check") {
                browserCalls += 1;
                if (browserCalls > this.maxBrowserRuns) {
                  budgetMessage = `run_browser_check 发起次数超过上限 ${this.maxBrowserRuns}`;
                }
              } else {
                codeCalls += 1;
                if (codeCalls > this.maxCodeReads) {
                  budgetMessage = `代码工具调用次数超过上限 ${this.maxCodeReads}`;
                }
              }
              if (budgetMessage) {
                if (budgetFlag === "budgetIterations") {
                  flags.budgetIterations = { message: budgetMessage };
                } else {
                  flags.budgetTools = { message: budgetMessage };
                }
                void session.abort();
                break;
              }
              const decision = buildDecisionFromToolCall(event.toolName, event.args);
              if (!decision) break;
              toolStarts.set(event.toolCallId, now());
              yield {
                type: "decision_made",
                runId,
                sequence: ++seq,
                timestamp: now(),
                decision,
              };
              yield {
                type: "tool_started",
                runId,
                sequence: ++seq,
                timestamp: now(),
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              };
              break;
            }
            case "tool_execution_end": {
              const durationMs = now() - (toolStarts.get(event.toolCallId) ?? now());
              if (event.toolName === "submit_report") {
                if (!event.isError && flags.report) {
                  yield {
                    type: "decision_made",
                    runId,
                    sequence: ++seq,
                    timestamp: now(),
                    decision: { kind: "respond", report: flags.report },
                  };
                }
                break;
              }
              const observation = observationByCallId.get(event.toolCallId);
              if (!observation) {
                // SDK 层的失败（参数校验等，产品工具没来得及登记观察）也要留痕：
                // 没有这条，事件流会"跳过"这次调用，评测无法区分模型判断错和工具没跑成
                if (event.isError) {
                  toolFailureCount += 1;
                  yield {
                    type: "tool_completed",
                    runId,
                    sequence: ++seq,
                    timestamp: now(),
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    status: "error",
                    error: {
                      code: "invalid_tool",
                      message: extractErrorText(event.result) ?? "工具执行失败（无观察记录）",
                    },
                    durationMs,
                  };
                }
                break;
              }
              const failed = event.isError || observation.status === "error";
              if (failed) toolFailureCount += 1;
              yield {
                type: "tool_completed",
                runId,
                sequence: ++seq,
                timestamp: now(),
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: failed ? "error" : "success",
                ...(failed
                  ? {
                      error: {
                        code:
                          event.toolName === "query_logs"
                            ? "log_source_unavailable"
                            : event.toolName === "run_browser_check"
                              ? "browser_run_failed"
                              : "code_query_failed",
                        message: observation.error ?? "材料查询失败",
                      },
                    }
                  : {
                      result:
                        observation.kind === "logs"
                          ? { entries: observation.evidence.length }
                          : observation.kind === "browser"
                            ? {
                                execution: observation.outcome?.execution,
                                reproduction: observation.outcome?.reproduction,
                              }
                            : { matches: observation.evidence.length },
                    }),
                durationMs,
              };
              yield {
                type: "observation_added",
                runId,
                sequence: ++seq,
                timestamp: now(),
                name: event.toolName,
                observation,
              };
              break;
            }
            case "agent_end": {
              // 用量按整个 run 的 assistant 消息累计（此前只取最后一条，多次轮次会漏计）
              for (const message of event.messages) {
                const m = message as {
                  role?: string;
                  stopReason?: string;
                  usage?: { input?: number; output?: number };
                };
                if (m?.role === "assistant") {
                  stopReason = m.stopReason ?? stopReason;
                  if (m.usage) {
                    usageInput = (usageInput ?? 0) + (m.usage.input ?? 0);
                    usageOutput = (usageOutput ?? 0) + (m.usage.output ?? 0);
                  }
                }
              }
              break;
            }
            case "agent_settled": {
              settled = true;
              break;
            }
            default:
              // message_update / compaction_* / queue_update / auto_retry_* / entry_*：不透传
              break;
          }
          continue;
        }
        if (settled || promptDone) break;
        await waitForEvent();
      }
      await promptPromise;
    } catch (err) {
      if (promptError === undefined) promptError = err;
    } finally {
      unsubscribe?.();
      try {
        session?.dispose();
      } catch {
        // dispose 失败不影响终态判定
      }
    }

    // ---- 终态判定（优先级见 ADAPTER-NOTES §3.6）----
    yield {
      type: "usage_reported",
      runId,
      sequence: ++seq,
      timestamp: now(),
      usage: {
        inputTokens: usageInput,
        outputTokens: usageOutput,
        toolCalls: queryCalls + codeCalls + browserCalls,
        durationMs: now() - startedAt,
        model: `${this.provider}/${this.modelId}`,
      },
    };
    if (flags.report) {
      yield {
        type: "run_completed",
        runId,
        sequence: ++seq,
        timestamp: now(),
        status: flags.report.status,
        result: flags.report,
        ...(flags.report.status === "partial"
          ? { missingMaterial: flags.report.missingMaterial }
          : {}),
      };
      return;
    }
    if (flags.noProgress) {
      yield { type: "run_failed", runId, sequence: ++seq, timestamp: now(), error: { code: "no_progress", message: flags.noProgress.message } };
      return;
    }
    if (flags.budgetTools) {
      yield { type: "run_failed", runId, sequence: ++seq, timestamp: now(), error: { code: "budget_tools", message: flags.budgetTools.message } };
      return;
    }
    if (flags.budgetIterations) {
      yield { type: "run_failed", runId, sequence: ++seq, timestamp: now(), error: { code: "budget_iterations", message: flags.budgetIterations.message } };
      return;
    }
    if (flags.timedOut && !flags.callerCancelled) {
      yield { type: "run_failed", runId, sequence: ++seq, timestamp: now(), error: { code: "budget_timeout", message: `诊断超过时间预算 ${this.timeoutMs}ms` } };
      return;
    }
    if (flags.callerCancelled || signal.aborted) {
      yield { type: "run_cancelled", runId, sequence: ++seq, timestamp: now() };
      return;
    }
    if (promptError !== undefined) {
      yield {
        type: "run_failed",
        runId,
        sequence: ++seq,
        timestamp: now(),
        error: { code: "runtime_error", message: promptError instanceof Error ? promptError.message : String(promptError) },
      };
      return;
    }
    if (stopReason === "error") {
      yield {
        type: "run_failed",
        runId,
        sequence: ++seq,
        timestamp: now(),
        error: { code: "provider_unavailable", message: "模型轮次以错误终止（SDK 自动重试后仍未恢复）" },
      };
      return;
    }
    yield {
      type: "run_failed",
      runId,
      sequence: ++seq,
      timestamp: now(),
      error: { code: "runtime_error", message: `模型未提交诊断报告（stopReason=${stopReason ?? "unknown"}）` },
    };
  }
}
