// 飞书群聊机器人接入适配器。
// 这里只做平台事件 → TicketTask 的确定性转换与回复编排；诊断语义仍由 Core/Runtime 决定。

import { createHash } from "node:crypto";
import type { AgentEvent, TicketTask } from "./contracts.ts";
import { describeEvent, extractReport, renderTicketComment } from "./core.ts";
import type { SubmitResult } from "./runtime.ts";

export interface FeishuMention {
  key?: string;
  name?: string;
}

export interface FeishuReceiveMessageEvent {
  sender?: { sender_type?: string };
  message?: {
    message_id?: string;
    create_time?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
}

export interface TicketRuntimePort {
  submit(task: TicketTask): Promise<SubmitResult>;
  waitUntilDone(runId: string): Promise<void>;
  getEvents(runId: string): Promise<AgentEvent[]>;
}

export interface FeishuMessenger {
  replyText(messageId: string, text: string): Promise<void>;
}

export type FeishuHandleResult =
  | { kind: "ignored"; reason: string }
  | { kind: "duplicate"; runId: string }
  | { kind: "accepted"; runId: string; task: TicketTask };

const MAX_INBOUND_CHARS = 20_000;
const MAX_REPLY_CHARS = 18_000;

function parseTextContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

function removeMentions(text: string, mentions: FeishuMention[] | undefined): string {
  let cleaned = text;
  for (const mention of mentions ?? []) {
    if (mention.key) cleaned = cleaned.replaceAll(mention.key, " ");
  }
  return cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/ *\r?\n */g, "\n")
    .trim();
}

function extractService(text: string): string | undefined {
  const labelled = text.match(/(?:服务(?:名)?|service)\s*[：:=]\s*([A-Za-z0-9._-]{2,100})/i)?.[1];
  if (labelled) return labelled;
  return text.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{1,99}-(?:service|server|api))\b/i)?.[1];
}

function extractCommit(text: string): string | undefined {
  return text.match(/(?:commit|代码版本|版本)\s*[：:=]?\s*(HEAD|[0-9a-f]{7,40})\b/i)?.[1];
}

function ticketIdOf(messageId: string): string {
  const readable = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(messageId).digest("hex").slice(0, 12);
  return `feishu_${readable}_${digest}`;
}

export function eventToTicket(event: FeishuReceiveMessageEvent): TicketTask | undefined {
  const message = event.message;
  if (event.sender?.sender_type && event.sender.sender_type !== "user") return undefined;
  if (!message?.message_id || message.chat_type !== "group" || message.message_type !== "text") {
    return undefined;
  }
  // 配合飞书后台的“获取群聊中 @ 机器人消息”最小权限使用；mentions 为空时拒绝处理。
  if (!message.mentions?.length) return undefined;

  const rawText = message.content ? parseTextContent(message.content) : undefined;
  if (!rawText) return undefined;
  const description = removeMentions(rawText, message.mentions).slice(0, MAX_INBOUND_CHARS);
  if (!description) return undefined;

  const firstLine = description.split(/\r?\n/, 1)[0].trim();
  const occurredAt = Number(message.create_time);
  const service = extractService(description);
  const commit = extractCommit(description);
  return {
    ticketId: ticketIdOf(message.message_id),
    title: firstLine.slice(0, 120),
    description,
    ...(service ? { service } : {}),
    ...(Number.isFinite(occurredAt) && occurredAt > 0 ? { occurredAt } : {}),
    ...(commit ? { commit } : {}),
  };
}

export class FeishuTicketBridge {
  private readonly runtime: TicketRuntimePort;
  private readonly messenger: FeishuMessenger;
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(runtime: TicketRuntimePort, messenger: FeishuMessenger) {
    this.runtime = runtime;
    this.messenger = messenger;
  }

  async handle(event: FeishuReceiveMessageEvent): Promise<FeishuHandleResult> {
    const task = eventToTicket(event);
    const messageId = event.message?.message_id;
    if (!task || !messageId) return { kind: "ignored", reason: "仅处理群聊中 @ 机器人的文本消息" };

    const submitted = await this.runtime.submit(task);
    if (!submitted.accepted) return { kind: "duplicate", runId: submitted.runId };

    // 诊断和飞书回复都在事件 ACK 之后执行，避免模型耗时导致飞书重投事件。
    const delivery = this.deliver(messageId, submitted.runId, task)
      .catch((err) => {
        console.error(`[feishu] 回复投递失败 messageId=${messageId}:`, err);
      })
      .finally(() => {
        this.deliveries.delete(messageId);
      });
    this.deliveries.set(messageId, delivery);
    return { kind: "accepted", runId: submitted.runId, task };
  }

  waitForDelivery(messageId: string): Promise<void> {
    return this.deliveries.get(messageId) ?? Promise.resolve();
  }

  private async deliver(messageId: string, runId: string, task: TicketTask): Promise<void> {
    try {
      await this.replyWithRetry(messageId, `ticket-doctor 已受理，运行编号：${runId}`);
    } catch (err) {
      // 受理提示失败不应阻止最终报告投递；二者是独立的用户可见消息。
      console.error(`[feishu] 受理提示发送失败 messageId=${messageId}:`, err);
    }
    await this.runtime.waitUntilDone(runId);
    const events = await this.runtime.getEvents(runId);
    const report = extractReport(events);
    const text = report
      ? renderTicketComment(task, report)
      : `ticket-doctor 未产出诊断报告。终态：${events.length ? describeEvent(events[events.length - 1]) : "未知"}`;
    await this.replyWithRetry(messageId, text.slice(0, MAX_REPLY_CHARS));
  }

  private async replyWithRetry(messageId: string, text: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.messenger.replyText(messageId, text);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    throw lastError;
  }
}
