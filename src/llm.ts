import { DEEPSEEK_API_KEY } from "./config.ts";

// 与模型对话的"唯一通道"。
// 这里用原生 fetch 手写 OpenAI 兼容协议的请求，不依赖任何 SDK。
// 对应 pi 里 agent-core 的 StreamFn 角色，但做成了最简版：非流式 + 流式两个通道。

// ---------- 类型定义（OpenAI 兼容协议里我们需要的最小子集） ----------

// 发给模型 / 从模型收来的消息。四种角色：
//   system   —— 系统提示，告诉模型"你是谁、有什么规矩"
//   user     —— 用户的输入
//   assistant—— 模型的回复（可能带着 tool_calls）
//   tool     —— 工具执行完返回的结果（必须带上 tool_call_id 对应回去）
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// 模型想要调用一个工具时返回的"调用请求"
export interface ToolCall {
  id: string;
  type: "function";
  index?: number;
  function: {
    name: string; // 工具名
    arguments: string; // 参数，是一段 JSON 字符串
  };
}

// 工具定义（function-calling 格式），告诉模型"有哪些工具可用、参数长什么样"
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

// 一次模型调用的"规整后"结果
export interface LlmResponse {
  content: string | null; // 文字回复；如果这轮只想调工具，可能是 null
  toolCalls: ToolCall[]; // 这轮想要调用的工具
  finishReason: string | null; // stop=正常结束，tool_calls=想调工具
}


const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

// DeepSeek 实际返回的 JSON 形状（我们只声明用到的字段）
interface DeepSeekResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

// ---------- 核心函数：发一轮请求 ----------

export async function callLlm(messages: ChatMessage[], tools: ToolDef[]): Promise<LlmResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 API key：请在 src/config.ts 里填 DEEPSEEK_API_KEY，或设置环境变量 DEEPSEEK_API_KEY。");
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages, // 把"整段对话"一次性发给模型（这就是上下文窗口的来源）
      tools: tools.length > 0 ? tools : undefined, // 本轮可用的工具
      stream: false, // 先用非流式，简单
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型接口返回错误 (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as DeepSeekResponse;
  const choice = data.choices?.[0];
  const msg = choice?.message;
  return {
    content: msg?.content ?? null,
    toolCalls: msg?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? null,
  };
}

// ---------- 流式调用 ----------
// 后端以 SSE 形式吐 token；这里把 delta 拼成完整的 content 和 tool_calls，
// 同时通过 onText 把每个文字片段实时交给上层（最终交给浏览器）。
export async function callLlmStream(
  messages: ChatMessage[],
  tools: ToolDef[],
  onText?: (text: string) => void,
): Promise<LlmResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 API key：请在 src/config.ts 里填 DEEPSEEK_API_KEY，或设置环境变量 DEEPSEEK_API_KEY。");
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型接口返回错误 (HTTP ${res.status}): ${text}`);
  }

  if (!res.body) {
    throw new Error("模型接口没有返回流式 body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolCallsByIndex = new Map<number, ToolCall>();

  let content = "";
  let finishReason: string | null = null;
  let buffer = "";

  const processLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;

    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;

    const chunk = JSON.parse(data) as {
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };

    const delta = chunk.choices?.[0]?.delta;
    const deltaText = delta?.content;
    if (typeof deltaText === "string" && deltaText !== "") {
      content += deltaText;
      onText?.(deltaText);
    }

    for (const rawCall of delta?.tool_calls ?? []) {
      const index = typeof rawCall.index === "number" ? rawCall.index : 0;
      let call = toolCallsByIndex.get(index);

      if (!call) {
        call = {
          id: rawCall.id ?? "",
          type: "function",
          index,
          function: { name: "", arguments: "" },
        };
        toolCallsByIndex.set(index, call);
      }

      if (rawCall.id) call.id = rawCall.id;
      if (rawCall.function?.name) call.function.name = rawCall.function.name;
      if (rawCall.function?.arguments) call.function.arguments += rawCall.function.arguments;
    }

    const reason = chunk.choices?.[0]?.finish_reason;
    if (typeof reason === "string") finishReason = reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") processLine(line);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim() !== "") processLine(buffer);

  return {
    content: content === "" ? null : content,
    toolCalls: [...toolCallsByIndex.values()],
    finishReason,
  };
}
