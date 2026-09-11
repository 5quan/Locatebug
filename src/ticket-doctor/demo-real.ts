// 阶段 2 真机演示：PiDiagnosisEngine（deepseek-v4-flash）× FileLogSource。
// 运行：npm run doctor:real
//
// 前置：DEEPSEEK_API_KEY —— 设置环境变量，或在项目根创建 .env 文件（已被 .gitignore 排除）：
//   DEEPSEEK_API_KEY=sk-xxxx
//
// 验证（对应 ADAPTER-NOTES §6）：
//   1. 事件流必须通过 assertRunInvariants（不过直接抛异常）；
//   2. 事件类型序列应与 fake demo 的完整路径一致（golden 对照）；
//   3. 报告可提取，且每条证据的 provenance 非空。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AgentEvent, TicketTask } from "./contracts.ts";
import { assertRunInvariants, describeEvent, extractReport, renderTicketComment } from "./core.ts";
import { GitCodeSource } from "./code-sources.ts";
import { FileLogSource } from "./log-sources.ts";
import { PiDiagnosisEngine } from "./pi-adapter.ts";

// 迷你 .env 加载（零依赖）：只填空缺的环境变量，不覆盖已有值
function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv(join(process.cwd(), ".env"));

if (!process.env.DEEPSEEK_API_KEY) {
  console.error(
    "缺少 DEEPSEEK_API_KEY。两种提供方式：\n" +
      "  1. 设置环境变量 DEEPSEEK_API_KEY\n" +
      "  2. 在项目根创建 .env 文件（已被 .gitignore 排除）：DEEPSEEK_API_KEY=sk-xxx",
  );
  process.exit(1);
}

const T0 = Date.parse("2026-09-06T10:02:00+08:00");
const SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const TASK: TicketTask = {
  ticketId: "BUG-1024",
  title: "下单接口批量 500",
  description: "2026-09-06 10:02 起下单接口大量 500，正常下单即可复现。",
  service: "checkout-service",
  occurredAt: T0,
  commit: "HEAD", // 提测带版本：本演示钉住本仓库当前版本，代码工具（search_code/read_code）启用
};

const engine = new PiDiagnosisEngine({
  logSource: new FileLogSource(SAMPLES_DIR),
  codeSource: (task) =>
    task.commit ? new GitCodeSource(PROJECT_ROOT, { commit: task.commit }) : undefined,
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  apiKey: process.env.DEEPSEEK_API_KEY, // 显式注入，比依赖 SDK 的环境变量发现更确定
  maxIterations: 6,
  timeoutMs: 120_000,
});

console.log(`模型：deepseek/deepseek-v4-flash（真机调用）\n`);

const events: AgentEvent[] = [];
for await (const event of engine.run(TASK, AbortSignal.timeout(180_000))) {
  events.push(event);
  console.log(describeEvent(event));
}

// 真机事件流也要过阶段 1 立的规矩：seq 单调、终态唯一且在最后
assertRunInvariants(events);
console.log("\n[断言] 事件流不变量校验：通过");

const report = extractReport(events);
console.log("\n---- 将写回工单备注的内容 ----\n");
if (report) {
  console.log(renderTicketComment(TASK, report));
  const unverified = report.hypotheses
    .flatMap((h) => h.evidence)
    .filter((e) => e.source.startsWith("unverified")).length;
  console.log(`\n[统计] 假设 ${report.hypotheses.length} 条，其中未核实证据 ${unverified} 条`);
} else {
  console.log("（本次运行没有产出报告，见上方终态事件）");
}
