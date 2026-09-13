// SkillRegistry 测试：固定版本加载、内容哈希、启用版本选择。
// 运行：npm test

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillRegistry } from "./skill-registry.ts";

async function makeSkillDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skills-"));
}

test("加载唯一 Skill：版本、正文与稳定内容哈希", async () => {
  const root = await makeSkillDir();
  try {
    const dir = join(root, "ticket-triage", "0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# 规则：先取证，再下结论", "utf8");

    const registry = new SkillRegistry(root);
    const skill = await registry.select();
    assert.ok(skill);
    assert.equal(skill.id, "ticket-triage");
    assert.equal(skill.version, "0.1.0");
    assert.equal(skill.body, "# 规则：先取证，再下结论");
    // 同内容 → 同哈希（64 位 hex），报告与事件据此追溯"当时用的是哪一版"
    assert.match(skill.contentHash, /^[0-9a-f]{64}$/);
    const again = await registry.select("ticket-triage");
    assert.equal(again?.contentHash, skill.contentHash);

    // 内容一变，哈希必须变（否则新旧版本的对照评测无从谈起）
    await writeFile(join(dir, "SKILL.md"), "# 规则：先取证，再下结论（修订）", "utf8");
    const changed = await registry.select("ticket-triage");
    assert.notEqual(changed?.contentHash, skill.contentHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("多版本时选最高启用版本；manifest.enabled=false 被跳过", async () => {
  const root = await makeSkillDir();
  try {
    for (const [version, body] of [
      ["0.1.0", "v0.1.0"],
      ["0.10.0", "v0.10.0"],
      ["0.9.0", "v0.9.0"],
    ] as const) {
      const dir = join(root, "ticket-triage", version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), body, "utf8");
    }
    await mkdir(join(root, "ticket-triage", "0.11.0"), { recursive: true });
    await writeFile(
      join(root, "ticket-triage", "0.11.0", "manifest.json"),
      JSON.stringify({ enabled: false }),
      "utf8",
    );
    await writeFile(join(root, "ticket-triage", "0.11.0", "SKILL.md"), "v0.11.0", "utf8");

    const skill = await new SkillRegistry(root).select();
    assert.ok(skill);
    // 0.11.0 被禁用；0.10.0 > 0.9.0 按数值比较而不是字典序
    assert.equal(skill.version, "0.10.0");
    assert.equal(skill.body, "v0.10.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("目录不存在 / 多个 Skill 未显式指定 / 未知 ID → 返回 undefined（无 Skill 运行）", async () => {
  assert.equal(await new SkillRegistry(join(tmpdir(), "no-such-skills")).select(), undefined);

  const root = await makeSkillDir();
  try {
    for (const id of ["skill-a", "skill-b"]) {
      const dir = join(root, id, "0.1.0");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "x", "utf8");
    }
    const registry = new SkillRegistry(root);
    assert.equal(await registry.select(), undefined, "多个 Skill 必须显式指定");
    assert.equal((await registry.select("skill-b"))?.id, "skill-b");
    assert.equal(await registry.select("skill-c"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
