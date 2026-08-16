// CLI 入口：默认新建会话；--session <id> 续聊；--list 列出所有会话。
import { createSession, listSessions } from "./session-store.ts";
import { runUserTurn } from "./turn.ts";

async function main(): Promise<void> {
  const args = parseArgs();

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

  const sessionId = args.sessionArg ?? (await createSession());
  const result = await runUserTurn(sessionId, userMessage);

  console.log(`会话：${result.sessionId}${args.sessionArg ? "（续）" : "（新建）"}`);
  console.log(`历史消息：${result.historyCount} 条（不含 system）`);
  console.log(`本轮新增：${result.added.length} 条\n`);

  console.log("===== 本轮新增消息 =====");
  for (const msg of result.added) {
    if (msg.role === "tool") {
      console.log(`[tool #${msg.tool_call_id}] ${ellipsize(msg.content)}`);
    } else {
      console.log(`[${msg.role}] ${ellipsize(msg.content ?? "")}`);
    }
  }

  console.log("\n===== 最终回复 =====\n");
  console.log(result.final || "(无回复)");
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


