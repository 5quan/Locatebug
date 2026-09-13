// 冒烟：不经过 server.ts（沙箱里 pi-coding-agent 包不完整），直接组装
// prepareContext（SHA 解析 + Skill 固定）+ Runtime + FakeEngine + JsonlRunLog，
// 验证 commit 透传、skill_selected 事件、requestKey 幂等与 runId 分离、证据渲染。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitCodeSource, resolveRepoSha } from "../src/ticket-doctor/code-sources.ts";
import { extractReport, renderTicketComment } from "../src/ticket-doctor/core.ts";
import { FakeDiagnosisEngine } from "../src/ticket-doctor/fake-engine.ts";
import { AuditedDiagnosisEngine } from "../src/ticket-doctor/audited-engine.ts";
import { FakeDiagnosisAuditor } from "../src/ticket-doctor/fake-auditor.ts";
import { FileLogSource } from "../src/ticket-doctor/log-sources.ts";
import { JsonlRunLog } from "../src/ticket-doctor/run-log.ts";
import { SkillRegistry } from "../src/ticket-doctor/skill-registry.ts";
import { TicketDoctorRuntime } from "../src/ticket-doctor/runtime.ts";

const ROOT = "/opt/locatebug/pi-demo";
const SAMPLES = join(ROOT, "samples");
const SKILLS = join(ROOT, "skills");

const dir = await mkdtemp(join(tmpdir(), "smoke-runs-"));
const skillRegistry = new SkillRegistry(SKILLS);
const repoConfig = { app: ROOT };

async function prepareContext(task) {
  const repos = [];
  for (const ref of task.repositories ?? (task.commit ? [{ repoId: "app", rev: task.commit }] : [])) {
    const d = repoConfig[ref.repoId];
    if (!d) throw new Error(`仓库 ${ref.repoId} 未配置`);
    const rev = ref.rev ?? "HEAD";
    repos.push({ repoId: ref.repoId, rev, sha: await resolveRepoSha(d, rev) });
  }
  const skill = await skillRegistry.select();
  assert.ok(skill, "默认 Skill 应能加载");
  return { ...(repos.length ? { repos } : {}), skill: { id: skill.id, version: skill.version, contentHash: skill.contentHash, source: skill.sourceDir } };
}

const runtime = new TicketDoctorRuntime({
  engine: new FakeDiagnosisEngine({ logSource: new FileLogSource(SAMPLES) }),
  runLog: new JsonlRunLog(dir),
  prepareContext,
});

// 1) 带 commit 提交：prepareContext 解析完整 SHA + 固定 Skill
const task = {
  ticketId: "BUG-SMOKE-1",
  title: "下单接口批量 500",
  description: "冒烟：commit 透传 + Skill 固定",
  service: "checkout-service",
  occurredAt: Date.parse("2026-09-06T10:02:00+08:00"),
  commit: "HEAD",
};
const first = await runtime.submit(task);
assert.equal(first.accepted, true);
await runtime.waitUntilDone(first.runId);
const events = await runtime.getEvents(first.runId);
const skillEvent = events.find((e) => e.type === "skill_selected");
assert.ok(skillEvent, "事件流应包含 skill_selected");
assert.equal(skillEvent.skill.id, "ticket-triage");
assert.match(skillEvent.skill.contentHash, /^[0-9a-f]{64}$/);
const report = extractReport(events);
assert.ok(report);
assert.ok(report.hypotheses.every((h) => h.status === "candidate"), "假引擎降级语义：候选原因");
const comment = renderTicketComment(task, report);
assert.ok(comment.includes("候选原因") || comment.includes("置信度"), "备注渲染可用");
console.log("[1] commit 透传 + skill_selected + runId 传入引擎：通过");

// 2) 相同内容重投 → duplicate，返回原 runId
const dup = await runtime.submit(task);
assert.equal(dup.accepted, false);
assert.equal(dup.reason, "duplicate");
assert.equal(dup.runId, first.runId);
console.log("[2] 同 requestKey（默认内容哈希）重投 → duplicate：通过");

// 3) 同工单不同 requestKey → 第二次独立运行（新旧 Skill 对照的前提）
const second = await runtime.submit(task, { requestKey: "req_eval_skill_v2" });
assert.equal(second.accepted, true);
assert.notEqual(second.runId, first.runId);
await runtime.waitUntilDone(second.runId);
const events2 = await runtime.getEvents(second.runId);
assert.equal(events2[0].runId, second.runId);
console.log("[3] 不同 requestKey → 独立 runId 独立事件流：通过");

// 4) 代码源在运行开始即解析出完整 SHA（HEAD → 40 位 commit）
const sha = await resolveRepoSha(ROOT, "HEAD");
assert.match(sha, /^[0-9a-f]{40}$/);
const source = await GitCodeSource.create(ROOT, { commit: "HEAD", repoId: "app" });
assert.equal(source.revision, sha);
const hits = await source.search({ pattern: "DiagnosisEngine" }, new AbortController().signal);
assert.ok(hits.length > 0);
console.log(`[4] GitCodeSource.create 钉住完整 SHA ${sha.slice(0, 10)}…，检索正常：通过`);

// 5) 坏 commit → prepareContext fail fast，不产生 run 文件
try {
  await prepareContext({ ticketId: "X", title: "x", description: "x", commit: "deadbeef00" });
  assert.fail("坏 commit 应该解析失败");
} catch (e) {
  assert.ok(String(e.message).includes("无法解析代码版本"));
}
console.log("[5] 坏 commit fail fast（不烧模型调用）：通过");

// 6) 独立审计 + 定向回流：审计过的引擎经 Runtime 落库，新事件（audit_completed 等）完整持久化
const auditedRuntime = new TicketDoctorRuntime({
  engine: new AuditedDiagnosisEngine({
    generator: new FakeDiagnosisEngine({ logSource: new FileLogSource(SAMPLES) }),
    auditor: new FakeDiagnosisAuditor(), // 确定性默认审计
  }),
  runLog: new JsonlRunLog(dir),
  prepareContext,
});
const audited = await auditedRuntime.submit({ ...task, ticketId: "BUG-SMOKE-AUDIT" });
assert.equal(audited.accepted, true);
await auditedRuntime.waitUntilDone(audited.runId);
const auditEvents = await auditedRuntime.getEvents(audited.runId);
const auditDone = auditEvents.find((e) => e.type === "audit_completed");
assert.ok(auditDone, "事件流应包含 audit_completed");
assert.equal(auditDone.attempt, 1);
const auditedReport = extractReport(auditEvents);
assert.ok(auditedReport?.audit?.verdict === "pass", "确定性审计应放行诚实的 candidate 报告");
const auditedComment = renderTicketComment({ ...task, ticketId: "BUG-SMOKE-AUDIT" }, auditedReport);
assert.ok(auditedComment.includes("独立审计：通过"), "备注渲染审计结论");
console.log("[6] 独立审计 + Runtime 落库（audit_completed 事件、报告审计落档、备注渲染）：通过");

console.log("\n冒烟全部通过。");
