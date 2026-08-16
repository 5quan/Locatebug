// 一轮用户消息：从会话日志读历史，追加 user，跑 agent，再追加本轮新增消息。
// CLI 和 HTTP server 共用这一份逻辑，保证两条入口行为一致。
import { step, type StepHandlers } from "./agent.ts";
import type { ChatMessage } from "./llm.ts";
import {
  appendMessage,
  appendTitle,
  readSession,
} from "./session-store.ts";
import { tools } from "./tools.ts";

export interface TurnResult {
  sessionId: string;
  historyCount: number;
  added: ChatMessage[];
  final: string;
}

export async function runUserTurn(
  sessionId: string,
  userMessage: string,
  handlers: StepHandlers = {},
): Promise<TurnResult> {
  // 1. 一次 readSession 同时拿到 messages / title / sandboxMode。
  const state = await readSession(sessionId);
  const history = state.messages;

  // 2. system 不入日志，每次运行重新注入最前面。
  const systemMsg: ChatMessage = { role: "system", content: "" };
  const userMsg: ChatMessage = { role: "user", content: userMessage };
  const fullContext: ChatMessage[] = [systemMsg, ...history, userMsg];

  // 3. 只追加这一条新 user；日志是 append-only，绝不能把整个 fullContext 重存一遍。
  await appendMessage(sessionId, userMsg);

  // 4. 没有 title 才追加 title。判断依据是日志状态，不是"有没有历史消息"。
  if (state.title === undefined) {
    await appendTitle(sessionId, userMessage);
  }

  // 5. step() 原地推进 fullContext，并把 token / 工具事件透传给上层。
  const before = fullContext.length;
  await step(fullContext, tools, 10, handlers);

  // 6. 只有 step 之后新增的消息需要追加。
  const added = fullContext.slice(before);
  for (const msg of added) {
    await appendMessage(sessionId, msg);
  }

  // 7. 最终回复 = 最后一条 assistant 的文字内容。
  const last = fullContext[fullContext.length - 1];
  const final = last?.role === "assistant" ? (last.content ?? "") : "";

  return {
    sessionId,
    historyCount: history.length,
    added,
    final,
  };
}
