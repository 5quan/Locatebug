// GitCodeSource 测试：以本仓库为标本（它本身是个 git 仓库）。
// 运行：npm test

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { GitCodeSource } from "./code-sources.ts";

const execFileP = promisify(execFile);
const REPO = process.cwd(); // npm test 在项目根执行
const ABORT = new AbortController().signal;

async function headCommit(): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", REPO, "rev-parse", "HEAD"]);
  return stdout.trim();
}

test("read：读 HEAD 版本的 package.json，内容与行号对应", async () => {
  const source = new GitCodeSource(REPO, { commit: await headCommit() });
  const snippets = await source.read({ path: "package.json", startLine: 1, endLine: 5 }, ABORT);
  assert.equal(snippets.length, 5);
  assert.equal(snippets[0].path, "package.json");
  assert.equal(snippets[0].line, 1);
  const whole = snippets.map((s) => s.text).join("\n");
  assert.ok(whole.includes('"pi-demo"'), "读到的应是本仓库的 package.json");
});

test("read：行号切片（含端点）与缺省行为", async () => {
  const source = new GitCodeSource(REPO, { commit: "HEAD" });
  const all = await source.read({ path: "package.json" }, ABORT);
  assert.ok(all.length > 5, "缺省应读到文件末尾（受上限约束）");

  const slice = await source.read({ path: "package.json", startLine: 3, endLine: 4 }, ABORT);
  assert.deepEqual(
    slice.map((s) => s.line),
    [3, 4],
    "切片按 1-based 含端点",
  );
});

test("search：按子串定位代码，glob 过滤路径", async () => {
  const source = new GitCodeSource(REPO, { commit: "HEAD" });
  const hits = await source.search({ pattern: "DiagnosisEngine" }, ABORT);
  assert.ok(hits.length > 0, "本仓库应能搜到 DiagnosisEngine");
  assert.ok(hits.every((s) => s.text.includes("DiagnosisEngine")));

  const filtered = await source.search({ pattern: "DiagnosisEngine", glob: "contracts.ts" }, ABORT);
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((s) => s.path.includes("contracts.ts")));
});

test("安全与错误路径：路径穿越/非法 commit/不存在的文件", async () => {
  const source = new GitCodeSource(REPO, { commit: "HEAD" });

  await assert.rejects(
    () => source.read({ path: "../outside/secret.txt" }, ABORT),
    /非法段|相对路径/,
  );
  await assert.rejects(() => source.read({ path: "no/such/file.txt" }, ABORT), /fatal|不存在|failed/i);

  assert.throws(() => new GitCodeSource(REPO, { commit: "main; rm -rf /" }), /非法 commit/);

  // 分段拼接，避免“用于证明不存在的完整字符串”出现在被检索的测试源码里。
  const missingPattern = ["__ticket_doctor_no_match__", "9f4c2a7e"].join("");
  const empty = await source.search({ pattern: missingPattern }, ABORT);
  assert.deepEqual(empty, [], "无命中返回空数组而不是报错");
});
