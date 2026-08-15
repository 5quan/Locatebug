// 交互式对话（REPL）：跑一次，然后一直输入一直答。
// 用 Node 内置的 readline，零依赖。
import { createInterface } from "node:readline";
import { step } from "./agent.ts";
import { tools } from "./tools.ts";
import type { ChatMessage } from "./llm.ts";

const SYSTEM_PROMPT =
  "你是一个乐于助人的终端助手。需要实时信息就调用 get_current_time，需要文件内容就调用 read_file。";

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 对话上下文：存在内存里，跨多轮一直保留——这就是"连续对话"的秘密
const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

// 把"问一行"包成 Promise，这样每轮都是"读一行 → 处理完 → 再读下一行"的严格顺序，
// 不会出现多个输入交错处理的问题。
function ask(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

console.log("开始对话（输入 /quit 或直接回车退出）");

async function loop(): Promise<void> {
  const line = await ask("你> ");
  const text = line.trim();
  if (text === "" || text === "/quit" || text === "exit") {
    console.log("再见！");
    rl.close();
    return;
  }

  messages.push({ role: "user", content: text });

  try {
    await step(messages, tools);
    const last = messages[messages.length - 1];
    const answer = last?.role === "assistant" ? (last.content ?? "(无文字内容)") : "(未得到回复)";
    console.log("\n助手> " + answer + "\n");
  } catch (error) {
    console.error("出错：" + (error instanceof Error ? error.message : String(error)));
  }

  await loop();
}

void loop();
