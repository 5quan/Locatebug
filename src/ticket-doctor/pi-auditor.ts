// 阶段 5：独立审计 Agent 的 Pi SDK 实现（诊断审计与定向回流的审计端）。
//
// 独立性的三重保障（对应第三板斧"审计 Agent 的价值在于不执行原任务"）：
//   1. 独立 Prompt：强制对抗视角——默认假设报告有问题，逐项给 pass/fail + 理由；
//   2. 独立上下文：只给"工单 + 待审报告 + 工具轨迹摘要 + 证据清单"，不给生成者的
//      完整中间推理（本产品本来也不产生中间推理事件，结构上杜绝了自我说服）；
//   3. 独立职责：只审复现有效性与归因充分性；引用正确性/版本一致性由 report-validator
//      的确定性检查负责，不在这里重复。
// 输出经 TypeBox 强制为三档结论（pass / degrade / reject）+ 结构化问题清单 + 回流方向建议。
// 程序（audited-engine.ts）根据结论定向触发补证 / 假设修订 / 报告降级。

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
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type {
  AuditConclusion,
  AuditInput,
  AuditIssue,
  DiagnosisAuditor,
} from "./contracts.ts";
import { MAX_EXCERPT_CHARS } from "./limits.ts";

// ---------- 审计提示词：对抗视角 + 结构化清单 + 三档输出（防橡皮图章） ----------
const AUDIT_SYSTEM_PROMPT = `你是独立的诊断审计员，审计一份 AI 预检报告。你不执行诊断任务，只挑战它的结论。
第一原则：你的默认假设是"这份报告可能有问题"。禁止默认它是对的；找不到问题时必须明确说
"未发现问题"，不许说"看起来不错"这类含糊表述。

逐项检查，每项给出独立判断和具体理由：
1. 复现有效性（reproduction_validity）：
   - 报告的 reproductionStatus 是否有工具轨迹支撑？宣称 reproduced 时，轨迹里必须有
     浏览器复现的观察记录；只有部分步骤通过、或断言从未执行到，都不足以支撑"已复现"；
   - 执行失败（找不到按钮/登录失效）被当成"未复现"或当成"根因"的，都要指出。
2. 归因充分性（attribution_sufficiency）：
   - 每个根因假设的证据是否足以支撑该强度的结论？单一日志片段支撑 verified、
     把局部证据过度归因为根因、跳过"请求是否发出/响应内容是什么"等关键验证直接下结论，
     都要指出；
   - 报告是否遗漏了工单中的关键信息（页面入口、复现步骤、错误日志线索）而没有解释原因。
3. 只有同时满足"证据充分 + 复现确认"时才允许 verified；达不到就给出具体问题。

输出规则：
- verdict 三档：pass（未发现问题）/ degrade（有瑕疵但不阻断交付，需标注）/ reject（不通过，需回流）；
- 每条 issue 必须给出 dimension、具体 description、reflowTarget 建议：
  缺复现/缺证据 → supplement_evidence；过度归因/结论过强 → revise_hypothesis；
  问题无法在预算内修复 → downgrade_report；
- 能定位到具体假设时给出 hypothesisIndex（0 起）；能定位到证据时给出 evidenceRef（证据 ID）；
- 用 submit_audit 工具提交结论，不要用普通文本回复。`;

// ---------- submit_audit 的 schema ----------
const auditSchema = Type.Object({
  verdict: Type.Union(
    [Type.Literal("pass"), Type.Literal("degrade"), Type.Literal("reject")],
    { description: "pass=未发现问题；degrade=有瑕疵但不阻断；reject=不通过需回流" },
  ),
  issues: Type.Array(
    Type.Object({
      dimension: Type.Union(
        [Type.Literal("reproduction_validity"), Type.Literal("attribution_sufficiency")],
        { description: "问题维度" },
      ),
      description: Type.String({ description: "具体问题（引用报告中的假设/证据编号，便于核对）" }),
      evidenceRef: Type.Optional(Type.String({ description: "证据 ID（如 E12）或轨迹引用" })),
      hypothesisIndex: Type.Optional(Type.Number({ description: "指向报告假设的下标（0 起）" })),
      reflowTarget: Type.Union(
        [
          Type.Literal("supplement_evidence"),
          Type.Literal("revise_hypothesis"),
          Type.Literal("downgrade_report"),
        ],
        { description: "建议的回流方向" },
      ),
    }),
    { description: "未发现问题时空数组" },
  ),
  summary: Type.Optional(Type.String({ description: "一句话总评" })),
});
type AuditParams = Static<typeof auditSchema>;

export interface PiAuditorOptions {
  provider?: string; // 默认 "deepseek"
  modelId?: string; // 默认 "deepseek-v4-flash"
  apiKey?: string;
  timeoutMs?: number; // 默认 60_000
  systemPrompt?: string;
}

// ---------- 审计输入包渲染（裁剪：不给生成者中间推理） ----------
function renderAuditInput(input: AuditInput): string {
  const lines: string[] = [];
  lines.push("== 原始工单 ==");
  lines.push(`工单号：${input.task.ticketId}`);
  lines.push(`标题：${input.task.title}`);
  lines.push(`描述：${input.task.description}`);
  if (input.task.service) lines.push(`所属服务：${input.task.service}`);
  if (input.task.entryUrl) lines.push(`页面入口：${input.task.entryUrl}`);
  if (input.task.expectedBehavior) lines.push(`预期行为：${input.task.expectedBehavior}`);
  if (input.task.actualBehavior) lines.push(`实际行为：${input.task.actualBehavior}`);
  if (input.task.reproductionSteps?.length) {
    lines.push("复现步骤：");
    for (const step of input.task.reproductionSteps) lines.push(`  - ${step}`);
  }

  lines.push("");
  lines.push("== 待审报告 ==");
  lines.push(`材料完整性 status：${input.report.status}`);
  if (input.report.reproductionStatus) lines.push(`复现状态：${input.report.reproductionStatus}`);
  input.report.hypotheses.forEach((h, i) => {
    lines.push(
      `假设${i}：${h.cause}｜置信度=${h.confidence}｜定位状态=${h.status ?? "未标注"}｜` +
        `证据=[${h.evidenceIds?.join(", ") || h.evidence.map((e) => e.evidenceId).filter(Boolean).join(", ") || "无"}]`,
    );
    if (h.pendingChecks?.length) lines.push(`  待验证项：${h.pendingChecks.join("；")}`);
  });

  lines.push("");
  lines.push("== 工具轨迹摘要（观察级，不含生成者推理）==");
  if (input.observations.length === 0) {
    lines.push("（本次运行没有任何工具调用观察记录——这本身就是归因充分性的重大疑点）");
  }
  input.observations.forEach((o, i) => {
    const target =
      o.kind === "logs"
        ? `service=${o.intent.service}`
        : o.kind === "code_search"
          ? `pattern=${o.intent.pattern}`
          : o.kind === "code_read"
            ? `path=${o.intent.path}`
            : "";
    const outcome =
      o.kind === "browser" && o.outcome
        ? ` 执行=${o.outcome.execution} 复现=${o.outcome.reproduction}`
        : "";
    lines.push(
      `#${i + 1} ${o.kind} ${target} 状态=${o.status}${outcome} 证据=${o.evidence.length}条${o.error ? ` 错误=${o.error}` : ""}`,
    );
  });

  lines.push("");
  lines.push("== 证据清单（含未被报告引用的证据）==");
  if (input.evidence.length === 0) {
    lines.push("（证据池为空）");
  }
  for (const e of input.evidence) {
    const ref = e.codeRef
      ? ` code=${e.codeRef.repoId}@${e.codeRef.sha.slice(0, 10)} ${e.codeRef.path}#L${e.codeRef.startLine}`
      : e.browserRef
        ? ` browser=${e.browserRef.channel}`
        : "";
    lines.push(
      `[${e.evidenceId ?? "?"}] ${e.source}${ref}${e.level ? ` 级别=${e.level}` : ""}｜${e.excerpt}`,
    );
  }

  lines.push("");
  lines.push("请按系统提示逐项审计，用 submit_audit 提交结论。");
  return lines.join("\n");
}

export class PiDiagnosisAuditor implements DiagnosisAuditor {
  private readonly provider: string;
  private readonly modelId: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly systemPrompt?: string;

  constructor(opts: PiAuditorOptions = {}) {
    this.provider = opts.provider ?? "deepseek";
    this.modelId = opts.modelId ?? "deepseek-v4-flash";
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.systemPrompt = opts.systemPrompt;
  }

  async audit(input: AuditInput, signal: AbortSignal): Promise<AuditConclusion> {
    let flags: { audit?: AuditParams } = {};
    let session: AgentSession | undefined;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const composed = AbortSignal.any([signal, timeoutSignal]);

    try {
      const agentDir = join(tmpdir(), "pi-ticket-doctor-auditor");
      mkdirSync(agentDir, { recursive: true });

      const modelRuntime = await ModelRuntime.create();
      if (this.apiKey) {
        await modelRuntime.setRuntimeApiKey(this.provider, this.apiKey);
      }
      const model = getBuiltinModel(
        this.provider as "deepseek",
        this.modelId as "deepseek-v4-flash",
      );
      if (!model) {
        throw new Error(`内置目录里找不到模型：${this.provider}/${this.modelId}`);
      }

      const submitAuditTool = defineTool({
        name: "submit_audit",
        label: "submit_audit",
        description: "提交审计结论（三档：pass/degrade/reject，附结构化问题清单）。",
        parameters: auditSchema,
        execute: async (_toolCallId, params: AuditParams) => {
          flags = { audit: params };
          return { content: [{ type: "text", text: "审计结论已接收。" }], details: { verdict: params.verdict } };
        },
      });

      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => this.systemPrompt ?? AUDIT_SYSTEM_PROMPT,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };

      const created = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
        noTools: "builtin",
        customTools: [submitAuditTool],
        sessionManager: SessionManager.inMemory(process.cwd()),
      });
      session = created.session;
      composed.addEventListener("abort", () => {
        void session?.abort();
      }, { once: true });

      await session.prompt(renderAuditInput(input));

      const params = flags.audit;
      if (!params) {
        throw new Error("审计模型未通过 submit_audit 提交结论");
      }
      const issues: AuditIssue[] = (params.issues ?? []).map((i) => ({
        dimension: i.dimension,
        description: i.description,
        ...(i.evidenceRef ? { evidenceRef: i.evidenceRef } : {}),
        ...(typeof i.hypothesisIndex === "number" ? { hypothesisIndex: i.hypothesisIndex } : {}),
        reflowTarget: i.reflowTarget,
      }));
      const conclusion: AuditConclusion = {
        verdict: params.verdict,
        issues,
        ...(params.summary ? { summary: params.summary } : {}),
      };
      return conclusion;
    } finally {
      try {
        session?.dispose();
      } catch {
        // dispose 失败不影响结论返回
      }
    }
  }
}
