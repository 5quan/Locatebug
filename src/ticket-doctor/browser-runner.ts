// 浏览器复现执行器 —— 模型生成受约束的操作计划，本模块负责校验、执行、取证、清理。
//
// 铁律：
// - 计划先过白名单校验，校验失败不开浏览器（防模型把执行器当任意脚本入口）；
// - 执行状态（execution：跑没跑完）与复现状态（reproduction：业务断言结果）分开记录，
//   "找不到按钮"属于执行失败，不等于没有 Bug；
// - 驱动异常一律归为环境阻塞（blocked），复现状态强制 indeterminate；
//   未跑完的运行不允许宣称 reproduced（本模块与报告校验器双重把关）；
// - 超时或取消后关闭会话：清理责任在本模块，不在驱动调用方。

import type {
  BrowserDriver,
  BrowserRunResult,
  ReproductionPlan,
} from "./contracts.ts";
import type { EvidenceInput } from "./evidence-store.ts";

export class PlanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRejectedError";
  }
}

export interface BrowserRunnerOptions {
  driver: BrowserDriver;
  maxSteps?: number; // 计划步数上限（预算在执行前校验），默认 12
  maxRequests?: number; // 网络取证条数上限，默认 40
  maxConsoleEntries?: number; // 控制台取证条数上限，默认 20
  maxTextChars?: number; // 单条取证文本截断长度，默认 600
  timeoutMs?: number; // 整体执行预算，默认 60_000
}

export interface BrowserRunArtifact {
  result: BrowserRunResult;
  /** 已截断、待登记进 EvidenceStore 的取证材料（登记时补 toolCallId） */
  evidenceInputs: Array<Omit<EvidenceInput, "toolCallId">>;
}

const MAX_FIELD_CHARS = 2_000;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export class BrowserRunner {
  private readonly driver: BrowserDriver;
  private readonly maxSteps: number;
  private readonly maxRequests: number;
  private readonly maxConsoleEntries: number;
  private readonly maxTextChars: number;
  private readonly timeoutMs: number;

  constructor(opts: BrowserRunnerOptions) {
    this.driver = opts.driver;
    this.maxSteps = opts.maxSteps ?? 12;
    this.maxRequests = opts.maxRequests ?? 40;
    this.maxConsoleEntries = opts.maxConsoleEntries ?? 20;
    this.maxTextChars = opts.maxTextChars ?? 600;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * 白名单校验：URL scheme、动作词表、字段长度、步数预算。
   * 校验失败抛 PlanRejectedError——这是"模型提案不合格"，不是浏览器失败，不开浏览器。
   */
  validatePlan(raw: unknown): ReproductionPlan {
    if (typeof raw !== "object" || raw === null) {
      throw new PlanRejectedError("复现计划必须是对象（entryUrl + steps）");
    }
    const plan = raw as { entryUrl?: unknown; steps?: unknown };
    const entryUrl = typeof plan.entryUrl === "string" ? plan.entryUrl.trim() : "";
    if (!/^https?:\/\//i.test(entryUrl)) {
      throw new PlanRejectedError(`entryUrl 必须是 http(s) 地址，实际：${entryUrl || "（空）"}`);
    }
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new PlanRejectedError("steps 必须是非空数组");
    }
    if (plan.steps.length > this.maxSteps) {
      throw new PlanRejectedError(`复现计划步数 ${plan.steps.length} 超过预算上限 ${this.maxSteps}`);
    }
    const allowed = new Set([
      "goto",
      "reload",
      "fill",
      "click",
      "press",
      "wait",
      "assert_visible",
      "assert_text",
    ]);
    const steps = plan.steps.map((step, i) => {
      if (typeof step !== "object" || step === null) {
        throw new PlanRejectedError(`第 ${i + 1} 步必须是对象`);
      }
      const s = step as Record<string, unknown>;
      const actionObj = s.action;
      if (typeof actionObj !== "object" || actionObj === null) {
        throw new PlanRejectedError(`第 ${i + 1} 步缺少 action 对象`);
      }
      const a = actionObj as Record<string, unknown>;
      const actionName = typeof a.action === "string" ? a.action : "";
      if (!allowed.has(actionName)) {
        throw new PlanRejectedError(`第 ${i + 1} 步动作 "${actionName}" 不在允许词表中`);
      }
      const stepId = typeof s.stepId === "string" && s.stepId ? clip(s.stepId, 64) : `step_${i + 1}`;
      const label = typeof s.label === "string" ? clip(s.label, 200) : undefined;
      // 字段按动作裁剪：执行器只把白名单字段传给驱动，其余（模型自由发挥的部分）丢弃
      const clean: Record<string, unknown> = { action: actionName };
      if (actionName === "goto") {
        const url = typeof a.url === "string" ? a.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) throw new PlanRejectedError(`第 ${i + 1} 步 goto 的 url 必须是 http(s) 地址`);
        clean.url = url;
      }
      if (actionName === "fill") {
        if (typeof a.selector !== "string" || !a.selector || a.selector.length > 500) {
          throw new PlanRejectedError(`第 ${i + 1} 步 fill 缺少 selector`);
        }
        if (typeof a.text !== "string" || a.text.length > 2_000) {
          throw new PlanRejectedError(`第 ${i + 1} 步 fill 的 text 缺失或超长`);
        }
        clean.selector = a.selector;
        clean.text = a.text;
      }
      if (actionName === "click" || actionName === "assert_visible") {
        if (typeof a.selector !== "string" || !a.selector || a.selector.length > 500) {
          throw new PlanRejectedError(`第 ${i + 1} 步 ${actionName} 缺少 selector`);
        }
        clean.selector = a.selector;
      }
      if (actionName === "press") {
        if (typeof a.key !== "string" || !a.key || a.key.length > 64) {
          throw new PlanRejectedError(`第 ${i + 1} 步 press 缺少 key`);
        }
        clean.key = a.key;
      }
      if (actionName === "wait") {
        if (typeof a.selector === "string" && a.selector) clean.selector = a.selector.slice(0, 500);
        if (typeof a.timeoutMs === "number" && Number.isFinite(a.timeoutMs)) {
          clean.timeoutMs = Math.min(Math.max(Math.floor(a.timeoutMs), 1), 30_000);
        }
      }
      if (actionName === "assert_text") {
        if (typeof a.selector !== "string" || !a.selector || a.selector.length > 500) {
          throw new PlanRejectedError(`第 ${i + 1} 步 assert_text 缺少 selector`);
        }
        if (typeof a.expected !== "string" || a.expected.length > MAX_FIELD_CHARS) {
          throw new PlanRejectedError(`第 ${i + 1} 步 assert_text 缺少 expected 或超长`);
        }
        clean.selector = a.selector;
        clean.expected = a.expected;
        if (a.comparison === "equals" || a.comparison === "contains") clean.comparison = a.comparison;
      }
      return { stepId, ...(label ? { label } : {}), action: clean };
    });
    return { entryUrl, steps };
  }

  async run(rawPlan: unknown, signal: AbortSignal): Promise<BrowserRunArtifact> {
    const plan = this.validatePlan(rawPlan);

    let result: BrowserRunResult;
    try {
      const composed = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
      result = await this.driver.execute(plan, composed);
    } catch (err) {
      // 驱动抛异常 = 环境阻塞（驱动崩溃/未安装/页面崩溃），不是"没有 Bug"
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: {
          execution: "blocked",
          reproduction: "indeterminate",
          steps: plan.steps.map((s) => ({
            stepId: s.stepId,
            action: String((s.action as { action: string }).action),
            ...(s.label ? { label: s.label } : {}),
            status: "skipped",
            error: `环境阻塞：${message}`,
          })),
          consoleErrors: [],
          requests: [],
        },
        evidenceInputs: [
          {
            kind: "browser",
            excerpt: `浏览器执行被环境阻塞：${message}`,
            browserRef: { channel: "page", url: plan.entryUrl },
          },
        ],
      };
    }

    const normalized = this.normalize(result, plan);
    return { result: normalized.result, evidenceInputs: normalized.evidenceInputs };
  }

  /**
   * 归一化驱动返回：截断取证；复现状态由本模块从业务断言步骤的结果推导，
   * 不信任驱动自报——"没跑到断言就宣布 not_reproduced/reproduced"都是说谎。
   *   任意 assert_* 失败               → reproduced（业务断言抓住了异常）
   *   全部 assert_* 通过              → not_reproduced（确实没复现）
   *   没有 assert_* / 没跑到断言      → indeterminate
   */
  private normalize(
    result: BrowserRunResult,
    plan: ReproductionPlan,
  ): BrowserRunArtifact {
    const execution = result.execution ?? "blocked";
    let reproduction: BrowserRunResult["reproduction"];
    if (execution === "blocked") {
      reproduction = "indeterminate";
    } else {
      const assertSteps = result.steps.filter(
        (s) => typeof s.action === "string" && s.action.startsWith("assert_") && s.status !== "skipped",
      );
      if (assertSteps.some((s) => s.status === "failed")) {
        reproduction = "reproduced";
      } else if (assertSteps.length > 0 && assertSteps.every((s) => s.status === "passed")) {
        reproduction = "not_reproduced";
      } else {
        reproduction = "indeterminate";
      }
    }

    const evidenceInputs: Array<Omit<EvidenceInput, "toolCallId">> = [];
    for (const step of result.steps) {
      if (step.status === "failed") {
        evidenceInputs.push({
          kind: "browser",
          excerpt: clip(
            `步骤 ${step.stepId}（${step.label ?? step.action}）失败：${step.error ?? step.detail ?? "未知原因"}`,
            this.maxTextChars,
          ),
          browserRef: { channel: "page", stepId: step.stepId, url: plan.entryUrl },
        });
      }
    }
    for (const req of result.requests.slice(0, this.maxRequests)) {
      const parts = [`${req.method} ${req.url}`, req.status !== undefined ? `→ ${req.status}` : ""]
        .filter(Boolean)
        .join(" ");
      const body = req.responseBody ?? req.requestBody;
      evidenceInputs.push({
        kind: "browser",
        excerpt: clip(body ? `${parts}\n${body}` : parts, this.maxTextChars),
        browserRef: { channel: "network", url: req.url },
      });
    }
    for (const line of result.consoleErrors.slice(0, this.maxConsoleEntries)) {
      evidenceInputs.push({
        kind: "browser",
        excerpt: clip(line, this.maxTextChars),
        browserRef: { channel: "console", url: plan.entryUrl },
      });
    }

    const normalizedResult: BrowserRunResult = {
      execution,
      reproduction,
      steps: result.steps.map((s) => ({
        ...s,
        ...(s.error ? { error: clip(s.error, this.maxTextChars) } : {}),
        ...(s.detail ? { detail: clip(s.detail, this.maxTextChars) } : {}),
      })),
      consoleErrors: result.consoleErrors.slice(0, this.maxConsoleEntries).map((l) => clip(l, this.maxTextChars)),
      requests: result.requests.slice(0, this.maxRequests).map((r) => ({
        ...r,
        ...(r.requestBody ? { requestBody: clip(r.requestBody, this.maxTextChars) } : {}),
        ...(r.responseBody ? { responseBody: clip(r.responseBody, this.maxTextChars) } : {}),
      })),
      ...(result.artifacts ? { artifacts: result.artifacts.slice(0, 10) } : {}),
    };
    return { result: normalizedResult, evidenceInputs };
  }
}
