// 简化版上下文压缩：step() 前检查，成功后追加单个 compaction 事件。
// 原始消息永不删除；模型上下文由摘要 checkpoint + 近期消息派生。
import { callLlm, type ChatMessage } from "./llm.ts";
import {
  appendCompaction,
  deriveContextMessages,
  type SessionMessageRecord,
  type SessionState,
} from "./session-store.ts";

const DEFAULT_THRESHOLD_TOKENS = 32_000;
const DEFAULT_KEEP_RECENT_TOKENS = 8_000;

const SUMMARY_SYSTEM_PROMPT = `你是上下文压缩器。你的任务是把较早的 Agent 对话压缩成一个可供另一个模型继续工作的结构化检查点。

只输出摘要，不要回答原对话中的问题，不要调用工具。保留准确的文件路径、函数名、命令、错误、用户约束、已完成工作和未完成事项。

使用以下固定结构：

## 目标
## 用户约束与偏好
## 已完成
## 当前进展
## 关键决策
## 重要文件和数据
## 未完成与阻塞
## 下一步`;

export interface CompactionSettings {
  thresholdTokens: number;
  keepRecentTokens: number;
}

export type SummarizeMessages = (
  messages: ChatMessage[],
  previousSummary?: string,
) => Promise<string>;

export interface CompactOptions {
  settings?: CompactionSettings;
  summarize?: SummarizeMessages;
}

export interface CompactResult {
  contextMessages: ChatMessage[];
  compacted: boolean;
}

interface CompactionSelection {
  messagesToSummarize: ChatMessage[];
  firstKeptSeq: number;
  retainedRecords: SessionMessageRecord[];
}

export function getCompactionSettings(): CompactionSettings {
  const thresholdTokens = readPositiveIntegerEnv(
    "COMPACTION_THRESHOLD_TOKENS",
    DEFAULT_THRESHOLD_TOKENS,
  );
  const keepRecentTokens = readPositiveIntegerEnv(
    "COMPACTION_KEEP_RECENT_TOKENS",
    DEFAULT_KEEP_RECENT_TOKENS,
  );

  if (keepRecentTokens >= thresholdTokens) {
    throw new Error(
      `COMPACTION_KEEP_RECENT_TOKENS (${keepRecentTokens}) 必须小于 `
      + `COMPACTION_THRESHOLD_TOKENS (${thresholdTokens})`,
    );
  }

  return { thresholdTokens, keepRecentTokens };
}

export async function compactIfNeeded(
  sessionId: string,
  state: SessionState,
  pendingUserMessage: ChatMessage,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const settings = options.settings ?? getCompactionSettings();
  const tokensBefore = estimateMessagesTokens([
    ...state.contextMessages,
    pendingUserMessage,
  ]);

  if (tokensBefore < settings.thresholdTokens) {
    return { contextMessages: state.contextMessages, compacted: false };
  }

  const activeRecords = activeMessageRecords(state);
  const selection = selectCompactionRange(activeRecords, settings.keepRecentTokens);
  if (selection === undefined) {
    console.warn("上下文达到压缩阈值，但没有可安全压缩的完整旧对话，继续使用原上下文");
    return { contextMessages: state.contextMessages, compacted: false };
  }

  let summary: string;
  try {
    summary = await (options.summarize ?? summarizeWithLlm)(
      selection.messagesToSummarize,
      state.compaction?.summary,
    );
    summary = summary.trim();
    if (!summary) {
      throw new Error("摘要模型返回了空内容");
    }

    const sourceTokens = estimateMessagesTokens(selection.messagesToSummarize)
      + (state.compaction === undefined ? 0 : estimateTextTokens(state.compaction.summary));
    const summaryTokens = estimateTextTokens(summary);
    if (summaryTokens >= sourceTokens) {
      throw new Error(`摘要没有缩短上下文：${summaryTokens} >= ${sourceTokens}`);
    }
  } catch (error) {
    console.warn(`上下文压缩失败，继续使用原上下文：${error instanceof Error ? error.message : String(error)}`);
    return { contextMessages: state.contextMessages, compacted: false };
  }

  // 持久化失败属于会话存储错误，不能伪装成普通摘要失败继续运行。
  await appendCompaction(sessionId, summary, selection.firstKeptSeq, tokensBefore);

  const contextMessages = deriveContextMessages(
    selection.retainedRecords,
    { summary, firstKeptSeq: selection.firstKeptSeq },
  );
  return { contextMessages, compacted: true };
}

// 中文字符按约 1 token，其他内容按约 4 字符 1 token；这是零依赖保守估算，不是模型 tokenizer。
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;

  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) {
      cjk++;
    } else {
      other++;
    }
  }

  return cjk + Math.ceil(other / 4);
}

export function estimateMessageTokens(message: ChatMessage): number {
  switch (message.role) {
    case "system":
    case "user":
      return estimateTextTokens(message.content);
    case "assistant":
      return estimateTextTokens(message.content ?? "")
        + estimateTextTokens(JSON.stringify(message.tool_calls ?? []));
    case "tool":
      return estimateTextTokens(message.tool_call_id) + estimateTextTokens(message.content);
  }
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function selectCompactionRange(
  records: SessionMessageRecord[],
  keepRecentTokens: number,
): CompactionSelection | undefined {
  if (records.length < 3) return undefined;

  let retainedTokens = 0;
  let targetIndex = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    retainedTokens += estimateMessageTokens(records[i].message);
    if (retainedTokens >= keepRecentTokens) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex <= 0) return undefined;

  // 只从 user 消息起点保留，避免拆开 assistant tool_call 与 tool result。
  let firstKeptIndex = -1;
  for (let i = targetIndex; i >= 1; i--) {
    if (records[i].message.role === "user") {
      firstKeptIndex = i;
      break;
    }
  }

  if (firstKeptIndex <= 0) return undefined;

  const messagesToSummarize = records
    .slice(0, firstKeptIndex)
    .map((record) => record.message);
  if (messagesToSummarize.length === 0) return undefined;

  return {
    messagesToSummarize,
    firstKeptSeq: records[firstKeptIndex].seq,
    retainedRecords: records.slice(firstKeptIndex),
  };
}

async function summarizeWithLlm(
  messages: ChatMessage[],
  previousSummary?: string,
): Promise<string> {
  const previous = previousSummary === undefined
    ? "（这是第一次压缩，没有旧摘要）"
    : `<previous-summary>\n${previousSummary}\n</previous-summary>`;
  const conversation = messages.map(serializeMessage).join("\n\n");
  const resp = await callLlm(
    [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          previous,
          "",
          "以下是这次需要合并进检查点的较早对话：",
          "",
          conversation,
        ].join("\n"),
      },
    ],
    [],
  );

  if (resp.toolCalls.length > 0) {
    throw new Error("摘要模型意外返回了工具调用");
  }
  if (resp.content === null || resp.content.trim() === "") {
    throw new Error("摘要模型没有返回文字内容");
  }
  return resp.content;
}

function activeMessageRecords(state: SessionState): SessionMessageRecord[] {
  const compaction = state.compaction;
  if (compaction === undefined) {
    return state.messageRecords;
  }
  return state.messageRecords.filter((record) => record.seq >= compaction.firstKeptSeq);
}

function serializeMessage(message: ChatMessage): string {
  switch (message.role) {
    case "system":
    case "user":
      return `[${message.role}]\n${message.content}`;
    case "assistant": {
      const calls = message.tool_calls?.length
        ? `\n工具调用：${JSON.stringify(message.tool_calls)}`
        : "";
      return `[assistant]\n${message.content ?? ""}${calls}`;
    }
    case "tool":
      return `[tool ${message.tool_call_id}]\n${message.content}`;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，实际为：${raw}`);
  }
  return value;
}
