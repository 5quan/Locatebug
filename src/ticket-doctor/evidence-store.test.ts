// EvidenceStore 测试：证据 ID 的签发、归属与解析（"证据约束交付"的地基语义）。
// 运行：npm test

import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceStore } from "./evidence-store.ts";

test("登记顺序签发 ID，且能按 ID 精确反查", () => {
  const store = new EvidenceStore("run_t1");
  const a = store.register({ kind: "log", excerpt: "ERROR 订单创建失败", source: "log-src", level: "ERROR" });
  const b = store.register({
    kind: "code",
    excerpt: "throw new IllegalStateException();",
    codeRef: { repoId: "app", sha: "a".repeat(40), path: "src/Order.java", startLine: 88, endLine: 88 },
  });

  assert.equal(a.evidenceId, "E1");
  assert.equal(b.evidenceId, "E2");
  assert.equal(store.get("E1")?.excerpt, "ERROR 订单创建失败");
  assert.equal(store.get("E2")?.codeRef?.path, "src/Order.java");
  assert.equal(store.get("E999"), undefined, "不存在的 ID 返回 undefined");
  assert.equal(store.size, 2);
});

test("每条证据都绑定 runId 与采集时间（归属可审计）", () => {
  const store = new EvidenceStore("run_mine");
  const entry = store.register({ kind: "log", excerpt: "x", source: "s" });
  assert.equal(entry.runId, "run_mine");
  assert.ok(entry.collectedAt > 0);
});

test("超长 excerpt 截断并标记 truncated", () => {
  const store = new EvidenceStore("run_t2");
  const entry = store.register({ kind: "log", excerpt: "x".repeat(500), source: "s" });
  assert.equal(entry.truncated, true);
  assert.ok(entry.excerpt.length < 500, "截断后不超过上限（含省略号）");
  const short = store.register({ kind: "log", excerpt: "short", source: "s" });
  assert.equal(short.truncated, false);
});

test("同一次工具调用内完全相同的片段幂等（一条采集物 = 一个 ID）", () => {
  const store = new EvidenceStore("run_t3");
  const first = store.register({ kind: "browser", toolCallId: "tc_1", excerpt: "GET /api/save → 200" });
  const again = store.register({ kind: "browser", toolCallId: "tc_1", excerpt: "GET /api/save → 200" });
  assert.equal(first.evidenceId, again.evidenceId);
  assert.equal(store.size, 1);
  // 不同工具调用采集的相同片段各自持 ID（来源不同，不能合并）
  const other = store.register({ kind: "browser", toolCallId: "tc_2", excerpt: "GET /api/save → 200" });
  assert.notEqual(first.evidenceId, other.evidenceId);
});

test("代码证据缺省 source 由 codeRef 渲染（repoId@sha path#L）", () => {
  const store = new EvidenceStore("run_t4");
  const entry = store.register({
    kind: "code",
    excerpt: "return null;",
    codeRef: { repoId: "frontend", sha: "abcdef1234".repeat(4), path: "src/a.ts", startLine: 3, endLine: 7 },
  });
  assert.ok(entry.source.includes("frontend@"));
  assert.ok(entry.source.includes("src/a.ts#L3-L7"));
});

test("resolveMany：未知 ID 保留 null 供校验器报错", () => {
  const store = new EvidenceStore("run_t5");
  store.register({ kind: "log", excerpt: "y", source: "s" });
  const resolved = store.resolveMany(["E1", "E404"]);
  assert.equal(resolved[0].entry?.evidenceId, "E1");
  assert.equal(resolved[1].entry, null);
});
