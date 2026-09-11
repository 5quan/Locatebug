// 阶段 2/4：DiagnosisEngine 的真实实现 —— Pi Agent SDK 被关在这唯一的文件里。
// 写法依据：src/ticket-doctor/ADAPTER-NOTES.md（映射笔记，先于本文件完成）+ SDK 0.84.2 源码。
// 铁律：SDK 的类型和事件不出本文件；对上层只暴露 contracts.ts 的产品事件。
//
// 材料源：query_logs（LogSource）+ search_code/read_code（CodeSource，工单带 commit 才启用）。
// 报告证据的反编造核验建立在统一证据池上：日志条目与代码行都以 {source, text} 入池，
// submit_report 引用的 excerpt 必须能在池中命中，否则标 unverified 并强制降置信度。

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
  CodeSource,
  Decision,
  DiagnosisEngine,
  DiagnosisReport,
  Evidence,
  QueryObservation,
  TicketTask,
} from "./contracts.ts";
import { MAX_EXCERPT_CHARS } from "./limits.ts";

// ---------- 默认诊断提示词 ----------
// 对抗 skill verification-log「观察 1」（模型跳过工具直接作答）：每一步都显式点名工具。
// status 判定是硬规则（2026-09-06 真机方差修正）：真机曾出现"把缺失说明写进假设正文却判 complete"，
// 因此把 partial 的触发条件写成可机械对照的条款，禁止用正文叙述代替 partial + missingMaterial。
const DEFAULT_SYSTEM_PROMPT = `你是 bug 工单的预检诊断员，产出供接手开发参考的初步根因分析。
规则：
1. 第一步必须调用 query_logs 工具查询相关服务的错误日志，禁止跳过，禁止凭空分析。
2. 只能基于 query_logs 返回的日志原文做归因；报告中每条证据的 excerpt 必须逐字摘自日志原文。
3. status 判定是硬规则，必须逐条对照：
   - 只要你尝试获取过某份材料但没有成功拿到（查询报错、日志文件/数据源不存在、无法核实你认为关键的环节），status 必须是 partial；
   - partial 时 missingMaterial 必须逐项列出缺失的材料及原因；
   - 查询成功但结果为空不算缺失（那是有效结论）；只有"想要但拿不到"才构成缺失；
   - 只有当你依赖的全部材料都成功获取、且假设完全建立在已获取的日志上时，才允许 complete；
   - 禁止把"缺失说明"写进假设正文或其他字段来代替 partial + missingMaterial。
4. 绝不编造；置信度必须反映证据的强度，而不是你行文的确定语气。
5. 报告必须通过 submit_report 工具提交，不要用普通文本回复代替提交。`;

// 工单带 commit 时追加的代码工具规则（版本已钉死，模型只能看这一版）
const CODE_TOOL_RULES = `
代码材料规则（本工单提供了代码版本，search_code / read_code 已启用）：
- search_code：按子串定位代码，返回 文件:行号:内容；read_code：按行查看文件内容。
- 先用日志/堆栈里的类名、方法名做 search_code，再用 read_code 核实上下文。
- 引用代码证据时，excerpt 必须逐字摘自该版本原文，并保留 文件:行号 信息。
- 代码里找不到工单描述的位置时如实说明，不得臆测文件内容。`;

// ---------- submit_report 的 schema：报告形状由 TypeBox 强制，不解析自由文本 ----------
const reportSchema = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial")], {
    description:
      "complete 仅当依赖的全部材料都成功获取且假设完全建立在已获取材料上；任何一次获取失败或关键材料缺失都必须选 partial",
  }),
  hypotheses: Type.Array(
    Type.Object({
      cause: Type.String({ description: "根因假设，一句话" }),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      evidence: Type.Array(
        Type.Object({
          time: Type.Optional(Type.String({ description: "日志条目时间，ISO8601；代码证据不填" })),
          level: Type.Optional(Type.String({ description: "日志级别，如 ERROR；代码证据不填" })),
          excerpt: Type.String({ description: "逐字摘自日志/代码原文的片段" }),
        }),
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
});
type SearchCodeParams = Static<typeof searchCodeSchema>;

const readCodeSchema = Type.Object({
  path: Type.String({ description: "相对代码根目录的文件路径，用 / 分隔" }),
  startLine: Type.Optional(Type.Number({ description: "起始行，1-based，默认 1" })),
  endLine: Type.Optional(Type.Number({ description: "结束行（含），默认起始行+199" })),
});
type ReadCodeParams = Static<typeof readCodeSchema>;

export interface PiDiagnosisOptions {
  logSource: import("./contracts.ts").LogSource;
  codeSource?:
    | CodeSource // 固定代码源（整个服务共用一个版本）
    | ((task: TicketTask) => CodeSource | undefined); // 按工单钉版本：工单带 commit 才给代码工具
  provider?: string; // 默认 "deepseek"
  modelId?: string; // 默认 "deepseek-v4-flash"（内置目录见 deepseek.json）
  apiKey?: string; // 不传则依赖环境变量发现（DEEPSEEK_API_KEY，env-api-keys.ts:87）
  maxIterations?: number; // query_logs 最多发起次数，默认 6
  maxCodeReads?: number; // search_code + read_code 合计上限，默认 10（budget_tools）
  timeoutMs?: number; // 默认 120_000
  systemPrompt?: string;
}

// 诊断过程中的可变状态：工具闭包写，终态判定读
interface RunFlags {
  report?: DiagnosisReport;
  noProgress?: { message: string };
  budgetIterations?: { message: string };
  budgetTools?: { message: string };
  callerCancelled: boolean;
  timedOut: boolean;
}

// 反编造核验池：日志条目与代码行统一入池，submit_report 的 excerpt 必须在池中命中
interface EvidencePoolItem {
  source: string;
  text: string;
  time?: number;
  level?: string;
}

// 把模型提交的证据核验、补全 provenance；未命中的标记 unverified 并强制降级 low
function verifyAndBuildReport(params: ReportParams, pool: EvidencePoolItem[]): DiagnosisReport {
  const hypotheses = params.hypotheses.map((h) => {
    const evidence: Evidence[] = h.evidence.map((ev) => {
      const needle = ev.excerpt.trim().toLowerCase();
      const hit = needle
        ? pool.find((item) => item.text.toLowerCase().includes(needle))
        : undefined;
      if (hit) {
        return {
          source: hit.source,
          time: hit.time,
          level: hit.level,
          excerpt:
            hit.text.length > MAX_EXCERPT_CHARS
              ? hit.text.slice(0, MAX_EXCERPT_CHARS) + "…"
              : hit.text,
        };
      }
      return {
        source: "unverified: 模型引用未在材料查询结果中命中",
        level: ev.level,
        excerpt: ev.excerpt,
      };
    });
    const hasUnverified = evidence.some((e) => e.source.startsWith("unverified"));
    return {
      cause: h.cause,
      confidence: hasUnverified ? ("low" as const) : h.confidence,
      evidence,
    };
  });
  return {
    status: params.status,
    hypotheses,
    suggestedNextSteps: params.suggestedNextSteps,
    missingMaterial: params.missingMaterial,
  };
}

// 把工单渲染成给模型看的第一条 user 消息
function renderTicketContext(task: TicketTask): string {
  return [
    `工单号：${task.ticketId}`,
    `标题：${task.title}`,
    `描述：${task.description}`,
    task.service ? `所属服务：${task.service}` : "所属服务：未知（请自行判断该查什么）",
    task.occurredAt ? `发生时间：${new Date(task.occurredAt).toISOString()}` : "发生时间：未知",
    task.commit
      ? `代码版本：${task.commit}（search_code / read_code 已启用，只能查看该版本）`
      : "代码版本：未提供（代码工具未启用；若需要代码定位，请在 missingMaterial 中说明缺代码版本）",
    "",
    "请按系统提示完成预检诊断：先 query_logs 查日志，再 submit_report 提交报告。",
  ].join("\n");
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
        },
      };
    default:
      return undefined; // 未知工具不产生产品决策
  }
}

export class PiDiagnosisEngine {
  private readonly logSource: import("./contracts.ts").LogSource;
  private readonly codeSourceSpec?: CodeSource | ((task: TicketTask) => CodeSource | undefined);
  private readonly provider: string;
  private readonly modelId: string;
  private readonly apiKey?: string;
  private readonly maxIterations: number;
  private readonly maxCodeReads: number;
  private readonly timeoutMs: number;
  private readonly systemPrompt?: string;

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(opts: PiDiagnosisOptions) {
    this.logSource = opts.logSource;
    this.codeSourceSpec = opts.codeSource;
    this.provider = opts.provider ?? "deepseek";
    this.modelId = opts.modelId ?? "deepseek-v4-flash";
    this.apiKey = opts.apiKey;
    this.maxIterations = opts.maxIterations ?? 6;
    this.maxCodeReads = opts.maxCodeReads ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.systemPrompt = opts.systemPrompt;
  }

  async *run(task: TicketTask, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const runId = `run_${task.ticketId}`;
    let seq = 0;
    let queryCalls = 0;
    let codeCalls = 0;
    const startedAt = Date.now();
    const now = () => Date.now();

    yield { type: "run_started", runId, sequence: ++seq, timestamp: now() };

    // 按工单解析代码源：工单带 commit 才有代码工具（"提测信息包含代码版本"是启用前提）
    const codeSource =
      typeof this.codeSourceSpec === "function" ? this.codeSourceSpec(task) : this.codeSourceSpec;

    const flags: RunFlags = { callerCancelled: false, timedOut: false };
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let promptError: unknown;
    // 终态原料：声明在 try 外，终态判定在 finally 之后
    let stopReason: string | undefined;
    let usageInputTokens: number | undefined;
    let usageOutputTokens: number | undefined;

    // 调用方取消与超时必须可区分（终态分别是 run_cancelled / budget_timeout）
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    signal.addEventListener("abort", () => {
      flags.callerCancelled = true;
    }, { once: true });
    timeoutSignal.addEventListener("abort", () => {
      flags.timedOut = true;
    }, { once: true });
    const composed = AbortSignal.any([signal, timeoutSignal]);

    // 反编造核验池 + 工具观察（按 toolCallId 存：真机见过并行工具调用，"最后一个"不可靠）
    const evidencePool: EvidencePoolItem[] = [];
    const observationByCallId = new Map<string, QueryObservation>();
    let lastQueryKey: string | null = null; // 空转守卫用：上次日志查询的指纹

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
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () =>
          (this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) +
          (codeSource ? CODE_TOOL_RULES : "") +
          // 预算透明化（2026-09-06 真机治理）：模型知道预算才会规划着花，而不是被硬刹车掐死在半路
          `\n预算（硬上限，无法申请追加）：query_logs 最多 ${this.maxIterations} 次；search_code / read_code 合计最多 ${this.maxCodeReads} 次。请规划查询，并在预算内务必提交报告。`,
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
        description: "查询指定服务在时间窗内的错误日志。先查日志，再下结论。",
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

          const entries = await this.logSource.query(intent, toolSignal ?? new AbortController().signal);
          const provenance = `${this.logSource.name} | keywords=[${params.keywords.join(",")}] | window=[${params.from} ~ ${params.to}]`;
          const evidence: Evidence[] = [];
          for (const e of entries) {
            evidence.push({
              source: provenance,
              time: e.time,
              level: e.level,
              excerpt:
                e.message.length > MAX_EXCERPT_CHARS
                  ? e.message.slice(0, MAX_EXCERPT_CHARS) + "…"
                  : e.message,
            });
            evidencePool.push({ source: provenance, text: e.message, time: e.time, level: e.level });
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
                    ? entries
                        .map((e) => `${new Date(e.time).toISOString()}\t${e.level}\t${e.message}`)
                        .join("\n")
                    : "（时间窗内没有匹配的日志条目）",
              },
            ],
            details: { count: entries.length },
          };
        },
      });

      const searchCodeTool = defineTool({
        name: "search_code",
        label: "search_code",
        description:
          "在工单指定版本的代码里按子串搜索（返回 文件:行号:内容）。用日志/堆栈里的类名、方法名定位代码。",
        parameters: searchCodeSchema,
        execute: async (toolCallId, params: SearchCodeParams, toolSignal) => {
          if (!codeSource) throw new Error("search_code 未启用：工单未提供代码版本");
          const intent = {
            pattern: params.pattern,
            ...(typeof params.glob === "string" ? { glob: params.glob } : {}),
          };
          const snippets = await codeSource.search(intent, toolSignal ?? new AbortController().signal);
          const evidence: Evidence[] = [];
          for (const s of snippets) {
            const source = `${codeSource.name} | ${s.path}#L${s.line}`;
            evidence.push({ source, excerpt: s.text });
            evidencePool.push({ source, text: s.text });
          }
          observationByCallId.set(toolCallId, {
            kind: "code_search",
            intent,
            status: "success",
            evidence,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  snippets.length > 0
                    ? snippets.map((s) => `${s.path}:${s.line}:${s.text}`).join("\n")
                    : "（没有匹配的代码行）",
              },
            ],
            details: { matches: snippets.length },
          };
        },
      });

      const readCodeTool = defineTool({
        name: "read_code",
        label: "read_code",
        description: "按行查看工单指定版本的源码文件内容（只读）。用于核实日志中出现的代码位置。",
        parameters: readCodeSchema,
        execute: async (toolCallId, params: ReadCodeParams, toolSignal) => {
          if (!codeSource) throw new Error("read_code 未启用：工单未提供代码版本");
          const intent = {
            path: params.path,
            ...(typeof params.startLine === "number" ? { startLine: params.startLine } : {}),
            ...(typeof params.endLine === "number" ? { endLine: params.endLine } : {}),
          };
          const snippets = await codeSource.read(intent, toolSignal ?? new AbortController().signal);
          const evidence: Evidence[] = [];
          for (const s of snippets) {
            const source = `${codeSource.name} | ${s.path}#L${s.line}`;
            evidence.push({ source, excerpt: s.text });
            evidencePool.push({ source, text: s.text });
          }
          observationByCallId.set(toolCallId, {
            kind: "code_read",
            intent,
            status: "success",
            evidence,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  snippets.length > 0
                    ? snippets.map((s) => `${s.line}: ${s.text}`).join("\n")
                    : "（文件为空或行号超出范围）",
              },
            ],
            details: { lines: snippets.length },
          };
        },
      });

      const submitReportTool = defineTool({
        name: "submit_report",
        label: "submit_report",
        description:
          "提交最终诊断报告。每条证据的 excerpt 必须逐字摘自 query_logs / search_code / read_code 返回的原文。",
        parameters: reportSchema,
        execute: async (_toolCallId, params: ReportParams) => {
          flags.report = verifyAndBuildReport(params, evidencePool);
          return {
            content: [{ type: "text", text: "报告已接收，诊断结束。" }],
            details: { status: params.status },
          };
        },
      });

      const created = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        settingsManager,
        noTools: "builtin", // 禁掉 read/write/edit/bash：消费不可信工单内容的服务不给 bash
        customTools: codeSource
          ? [queryLogsTool, searchCodeTool, readCodeTool, submitReportTool]
          : [queryLogsTool, submitReportTool],
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
              // 预算：日志查询与代码查询分别计数（ADAPTER-NOTES §3.4/3.5）
              if (event.toolName === "query_logs") {
                queryCalls++;
                if (queryCalls > this.maxIterations) {
                  flags.budgetIterations = {
                    message: `query_logs 发起次数超过上限 ${this.maxIterations}`,
                  };
                  void session.abort();
                  break;
                }
              } else {
                codeCalls++;
                if (codeCalls > this.maxCodeReads) {
                  flags.budgetTools = {
                    message: `代码工具调用次数超过上限 ${this.maxCodeReads}`,
                  };
                  void session.abort();
                  break;
                }
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
              if (!observation) break;
              const failed = event.isError || observation.status === "error";
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
                        code: event.toolName === "query_logs" ? "log_source_unavailable" : "code_query_failed",
                        message: observation.error ?? "材料查询失败",
                      },
                    }
                  : {
                      result:
                        observation.kind === "logs"
                          ? { entries: observation.evidence.length }
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
              // usage/stopReason 都从最后一条 assistant message 取；deepseek 老路径可能没有 usage
              const messages = event.messages;
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i] as {
                  role?: string;
                  stopReason?: string;
                  usage?: { input?: number; output?: number };
                } | undefined;
                if (m?.role === "assistant") {
                  stopReason = m.stopReason;
                  if (m.usage) {
                    usageInputTokens = m.usage.input;
                    usageOutputTokens = m.usage.output;
                  }
                  break;
                }
              }
              break;
            }
            case "agent_settled": {
              settled = true;
              break;
            }
            default:
              // message_update / compaction_* / queue_update / auto_retry_* / entry_*：v1 不透传
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
        inputTokens: usageInputTokens,
        outputTokens: usageOutputTokens,
        toolCalls: queryCalls + codeCalls,
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
