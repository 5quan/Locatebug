// 入口：把"一次 agent 回答"接到"持久会话"上。
// 默认新建会话；--session <id> 续聊；--list 列出所有会话。
import { step } from "./agent.ts";
import type { ChatMessage } from "./llm.ts";
import { tools } from "./tools.ts";
import {
  appendMessage,
  createSession,
  listSessions,
  loadSession,
} from "./session-store.ts";

async function main(): Promise<void> {
  const args = parseArgs();

  // --list：只看目录，不调用模型
  if (args.list) {
    const sessions = await listSessions();
    console.log("===== 会话列表 =====");

    if (sessions.length === 0) {
      console.log("（还没有会话，先提一个问题）");
    } else {
      for (const session of sessions) {
        console.log(`${session.id}\t${session.title}`);
      }
    }
    return;
  }

  // 没有 --session 时保留原来的默认问题；有 --session 但没给问题则报用法
  const userMessage = args.userMessage || (args.sessionArg ? "" : "读一下 README.md，告诉我这个项目是干嘛的");
  if (!userMessage) {
    console.error('用法：npm start -- "你的问题"');
    console.error('续聊：npm start -- --session <会话id> "你的问题"');
    console.error("列出会话：npm start -- --list");
    process.exitCode = 1;
    return;
  }

  await runOneTurn(userMessage, args.sessionArg);
}

async function runOneTurn(userMessage: string, sessionArg?: string): Promise<void> {
  // 1. 确定会话：续聊用传入 id，否则新建一个
  const sessionId = sessionArg ?? (await createSession());

  // 2. 从日志重放历史；system 不入日志，每次运行重新注入到最前面
  const history = await loadSession(sessionId);
  const systemMsg: ChatMessage = { role: "system", content: "" };
  const userMsg: ChatMessage = { role: "user", content: userMessage };
  const fullContext: ChatMessage[] = [systemMsg, ...history, userMsg];

  // 3. 先只追加"这一条"新 user 消息。
  //    日志是 append-only，绝不能把整个 fullContext 再存一遍。
  await appendMessage(sessionId, userMsg);

  // 4. step() 会原地往 fullContext 里 push 本轮产生的 assistant/tool 消息
  const before = fullContext.length;
  await step(fullContext, tools);

  // 5. 只有 step 之后新增的消息需要追加
  const added = fullContext.slice(before);
  for (const msg of added) {
    await appendMessage(sessionId, msg);
  }

  console.log(`会话：${sessionId}${sessionArg ? "（续）" : "（新建）"}`);
  console.log(`历史消息：${history.length} 条（不含 system）`);
  console.log(`本轮新增：${added.length} 条\n`);

  console.log("===== 本轮新增消息 =====");
  for (const msg of added) {
    if (msg.role === "tool") {
      console.log(`[tool #${msg.tool_call_id}] ${ellipsize(msg.content)}`);
    } else {
      console.log(`[${msg.role}] ${ellipsize(msg.content ?? "")}`);
    }
  }

  const last = fullContext[fullContext.length - 1];
  console.log("\n===== 最终回复 =====\n");
  console.log(
    last?.role === "assistant" ? (last.content ?? "(无文字内容)") : "(无回复)",
  );
}

function parseArgs(): { sessionArg?: string; list: boolean; userMessage: string } {
  let sessionArg: string | undefined;
  let list = false;
  const parts: string[] = [];

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === "--list") {
      list = true;
    } else if (arg === "--session") {
      sessionArg = process.argv[i + 1];
      if (!sessionArg) {
        throw new Error("--session 后面需要会话 id");
      }
      i++;
    } else {
      parts.push(arg);
    }
  }

  return { sessionArg, list, userMessage: parts.join(" ") };
}

function ellipsize(text: string, max = 160): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

main().catch((error) => {
  console.error(
    "运行失败：" + (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});

