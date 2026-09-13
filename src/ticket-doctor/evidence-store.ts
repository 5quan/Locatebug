// 证据登记与签发 —— "证据约束交付"的地基。
//
// 职责：工具执行时把采集到的每条证据登记入册，签发运行内唯一 ID（E1、E2…）。
// 模型在 submit_report 里只提交 evidenceId；报告校验器（report-validator.ts）
// 用 ID 从这里反查真实来源、版本和位置，再填进正式报告。
//
// 为什么不让模型复述 excerpt + 行号：相同代码出现在多个文件时字符串匹配会关联错位，
// 短引用会命中无关材料——引用错位的根因就是让模型填这些字段。ID 由系统签发，错不了。

import type {
  BrowserEvidenceRef,
  CodeEvidenceRef,
  Evidence,
} from "./contracts.ts";
import { MAX_EXCERPT_CHARS } from "./limits.ts";

export type EvidenceKind = "log" | "code" | "browser";

export interface EvidenceInput {
  kind: EvidenceKind;
  toolCallId?: string; // 哪次工具调用采集的（轨迹追溯）
  excerpt: string; // 原文片段（本模块负责截断到 MAX_EXCERPT_CHARS）
  source?: string; // provenance 文本；代码证据可省略（由 codeRef 渲染）
  time?: number;
  level?: string;
  codeRef?: CodeEvidenceRef;
  browserRef?: BrowserEvidenceRef;
}

export interface StoredEvidence extends Evidence {
  evidenceId: string;
  runId: string;
  kind: EvidenceKind;
  toolCallId?: string;
  collectedAt: number;
  truncated: boolean;
}

function truncate(text: string): { excerpt: string; truncated: boolean } {
  if (text.length > MAX_EXCERPT_CHARS) {
    return { excerpt: text.slice(0, MAX_EXCERPT_CHARS) + "…", truncated: true };
  }
  return { excerpt: text, truncated: false };
}

function renderCodeSource(ref: CodeEvidenceRef): string {
  const shortSha = ref.sha.length > 10 ? ref.sha.slice(0, 10) : ref.sha;
  const line = ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}-L${ref.endLine}`;
  return `${ref.repoId}@${shortSha} ${ref.path}#${line}`;
}

function renderBrowserSource(ref: BrowserEvidenceRef): string {
  const step = ref.stepId ? ` step=${ref.stepId}` : "";
  const url = ref.url ? ` ${ref.url}` : "";
  return `browser:${ref.channel}${step}${url}`;
}

export class EvidenceStore {
  private readonly runId: string;
  private readonly entries = new Map<string, StoredEvidence>();
  private counter = 0;

  constructor(runId: string) {
    this.runId = runId;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 登记一条证据并签发 ID。excerpt 超长自动截断并标记 truncated。 */
  register(input: EvidenceInput): StoredEvidence {
    const text = truncate(input.excerpt);
    // 同一工具调用内完全相同的片段不重复签发（浏览器会把同一请求记多次）：
    // 用 (kind, toolCallId, excerpt) 做幂等键，保证"一条采集物 = 一个 ID"。
    const dedupKey = `${input.kind}\u0000${input.toolCallId ?? ""}\u0000${text.excerpt}`;
    for (const existing of this.entries.values()) {
      const existingKey = `${existing.kind}\u0000${existing.toolCallId ?? ""}\u0000${existing.excerpt}`;
      if (existingKey === dedupKey) return existing;
    }
    this.counter += 1;
    const evidenceId = `E${this.counter}`;
    const entry: StoredEvidence = {
      evidenceId,
      runId: this.runId,
      kind: input.kind,
      toolCallId: input.toolCallId,
      collectedAt: Date.now(),
      excerpt: text.excerpt,
      truncated: text.truncated || input.truncated === true,
      source:
        input.source ??
        (input.codeRef ? renderCodeSource(input.codeRef) : undefined) ??
        (input.browserRef ? renderBrowserSource(input.browserRef) : "unknown"),
    };
    if (input.time !== undefined) entry.time = input.time;
    if (input.level !== undefined) entry.level = input.level;
    if (input.codeRef) entry.codeRef = input.codeRef;
    if (input.browserRef) entry.browserRef = input.browserRef;
    this.entries.set(evidenceId, entry);
    return entry;
  }

  get(evidenceId: string): StoredEvidence | undefined {
    return this.entries.get(evidenceId);
  }

  /** 批量解析；返回 (id, entry|null) 有序对，未知 ID 保留 null 供校验器报错。 */
  resolveMany(ids: string[]): Array<{ id: string; entry: StoredEvidence | null }> {
    return ids.map((id) => ({ id, entry: this.entries.get(id) ?? null }));
  }

  all(): StoredEvidence[] {
    return [...this.entries.values()].sort(
      (a, b) => Number(a.evidenceId.slice(1)) - Number(b.evidenceId.slice(1)),
    );
  }
}
