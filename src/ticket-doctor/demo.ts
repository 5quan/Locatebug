// 阶段 1 端到端演示：全程假适配器，无网络、无 SDK。
// 运行：npm run doctor:demo
//
// 演示两个场景：
//   1. 正常路径：工单带服务名与发生时间 → 查样例日志 → complete 报告；
//   2. 失败路径：服务名在日志源里不存在 → partial 报告并列出缺失材料。
// 最后打印的文本，就是阶段 4 将写回云效工单备注的内容。

import { fileURLToPath } from "node:url";
import type { AgentEvent, LogSource, TicketTask } from "./contracts.ts";
import { describeEvent, extractReport, renderTicketComment } from "./core.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { FileLogSource } from "./log-sources.ts";

const T0 = Date.parse("2026-09-06T10:02:00+08:00");
const SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

async function runScenario(name: string, task: TicketTask, logSource: LogSource): Promise<void> {
  console.log(`\n========== 场景：${name} ==========`);
  const engine = new FakeDiagnosisEngine({ logSource, runId: `run_${task.ticketId}` });
  const events: AgentEvent[] = [];
  for await (const event of engine.run(task, AbortSignal.timeout(10_000))) {
    events.push(event);
    console.log(describeEvent(event));
  }
  const report = extractReport(events);
  console.log("\n---- 将写回工单备注的内容 ----\n");
  console.log(report ? renderTicketComment(task, report) : "（本次运行没有产出报告，见上方终态事件）");
}

await runScenario(
  "正常路径：日志里能找到错误",
  {
    ticketId: "BUG-1024",
    title: "下单接口批量 500",
    description: "2026-09-06 10:02 起下单接口大量 500，正常下单即可复现。",
    service: "checkout-service",
    occurredAt: T0,
  },
  new FileLogSource(SAMPLES_DIR),
);

await runScenario(
  "失败路径：日志源里没有这个服务",
  {
    ticketId: "BUG-1025",
    title: "用户反馈支付失败",
    description: "支付页面报错，服务名暂不明确。",
    service: "no-such-service",
    occurredAt: T0,
  },
  new FileLogSource(SAMPLES_DIR),
);
