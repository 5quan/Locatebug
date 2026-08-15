// 入口：组装一个 agent，问它一句话，然后打印整个过程。
import { runAgent } from "./agent.ts";
import { tools } from "./tools.ts";

// 第一个命令行参数是提问；不传就用默认问题
const userMessage = process.argv[2] ?? "现在几点？顺便读一下 README.md";

console.log("用户提问：" + userMessage + "\n");

try {
  const messages = await runAgent({
    systemPrompt:
      "需要实时信息就调用 get_current_time，需要文件内容就调用 read_file。",
    userMessage,
    tools,
  });

  // 打印"完整消息记录"——这就是 agent 的全部真相：
  // 一段来回 append、最后整包发给模型的对话数组。
  console.log("===== 完整消息记录（发给模型 / 模型返回的一切）=====\n");
  for (const m of messages) {
    if (m.role === "tool") {
      console.log(`[tool #${m.tool_call_id}] ${ellipsize(m.content)}`);
    } else {
      console.log(`[${m.role}] ${ellipsize(m.content ?? "")}`);
    }
  }

  const last = messages[messages.length - 1];
  console.log("\n===== 最终回复 =====\n");
  console.log(last?.role === "assistant" ? (last.content ?? "(无文字内容)") : "(无回复)");
} catch (error) {
  console.error("运行失败：" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

function ellipsize(text: string, max = 160): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
