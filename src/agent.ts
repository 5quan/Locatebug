// agent 循环：整个项目的"心脏"，也是 agent 最本质的那十几行。
// 对应 pi 里的 agent-loop.ts，但去掉了事件流、队列、并行等产品级东西。

import { callLlmStream, type ChatMessage, type ToolDef } from "./llm.ts";
import type { Tool } from "./tools.ts";

export interface RunOptions {
  systemPrompt: string;
  userMessage: string;
  tools?: Tool[];
  maxTurns?: number; // 防止模型一直调工具导致死循环的安全上限
}

// step 循环过程中向上抛的事件。CLI 可以忽略，HTTP/SSE 层拿它们做实时输出。
export interface StepHandlers {
  onAssistantText?: (text: string) => void;
  onToolStart?: (name: string, argsJson: string) => void;
  onToolResult?: (name: string, content: string) => void;
}

// 从"空对话"开始，跑一个一次性问答，返回完整消息记录。
export async function runAgent(options: RunOptions): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userMessage },
  ];
  await step(messages, options.tools ?? [], options.maxTurns ?? 10);
  return messages;
}

// 核心：把一段对话"往前推一步"。
// 传入的 messages 数组会被原地修改（append 模型的回复和工具结果），
// 所以 REPL 可以一直复用同一个数组，实现"记住前面说过的话"的连续对话。
export async function step(
  messages: ChatMessage[],
  tools: Tool[],
  maxTurns = 10,
  handlers: StepHandlers = {},
): Promise<void> {
  // 循环：一轮 = 问模型一次 + (可能)执行它要的工具
  for (let turn = 0; turn < maxTurns; turn++) {
    const toolDefs: ToolDef[] = tools.map((t) => t.def);
    const resp = await callLlmStream(messages, toolDefs, handlers.onAssistantText);

    // 把模型的回复 append 进上下文（记住它说了啥）
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: resp.content,
      ...(resp.toolCalls.length > 0 ? { tool_calls: resp.toolCalls } : {}),
    };
    messages.push(assistantMsg);

    // 没有工具调用 = 模型答完了，结束
    if (resp.toolCalls.length === 0) {
      return;
    }

    // 模型想调工具：我们替它执行，把结果作为 tool 消息塞回上下文
    for (const call of resp.toolCalls) {
      handlers.onToolStart?.(call.function.name, call.function.arguments);

      const result = await executeTool(call.function.name, call.function.arguments, tools);
      handlers.onToolResult?.(call.function.name, result);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    // 回到循环顶：模型看到工具结果后继续，直到它不再调工具为止
  }
}

// 根据名字找到工具、解析参数、执行，并把任何失败都转成"文本"返回给模型
async function executeTool(name: string, argsJson: string, tools: Tool[]): Promise<string> {
  const tool = tools.find((t) => t.def.function.name === name);
  if (!tool) {
    return `错误：找不到名为 ${name} 的工具`;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return `错误：工具 ${name} 的参数不是合法 JSON：${argsJson}`;
  }

  try {
    return await tool.run(args);
  } catch (error) {
    // 工具失败不要"崩掉"整个 agent，而是把错误作为结果回给模型，
    // 模型看到错误后可以自己换个方法重试。这就是 README 里说的"失败要 throw"的另一面。
    return `错误：工具 ${name} 执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
