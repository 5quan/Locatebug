// Skill 注册表 —— 诊断 Skill 的选择、版本固定与内容哈希。
//
// 设计要点（对应"反馈驱动 Skill 优化"的第一步：先让 Skill 真的存在、可加载、可追溯）：
// - 目录布局：<root>/<skillId>/<version>/SKILL.md（+ 可选 manifest.json，仅用于 enabled 开关）；
// - select() 在运行开始时调用一次：选出启用版本，读取 SKILL.md 原文，计算 sha256 内容哈希；
// - 运行中不热更新：引擎拿到的是不可变的 SkillBinding + 正文快照，事件流记录 skill_selected；
// - 版本比较按数值段比较（0.2.0 > 0.10.0 按数值而不是字典序），无法解析时退化为字符串比较。

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface SkillPackage {
  id: string;
  version: string;
  contentHash: string; // SKILL.md 原文的 sha256（hex）
  body: string; // SKILL.md 原文（注入 system prompt 的方法论部分）
  sourceDir: string;
}

export class SkillRegistry {
  private readonly rootDir: string;

  // 不用构造器参数属性：Node 原生类型剥离不支持（见 fake-engine.ts 说明）
  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /**
   * 选出并加载一个 Skill 的固定版本。
   * @param skillId 缺省时：目录下只有一个 Skill 就选它，多个则返回 undefined（必须显式指定）。
   * @returns 选中的 Skill 快照；没有任何可用版本时返回 undefined（引擎在无 Skill 下运行）。
   */
  async select(skillId?: string): Promise<SkillPackage | undefined> {
    let ids: string[];
    try {
      ids = (await readdir(this.rootDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return undefined; // 根目录不存在 = 没有装任何 Skill
    }
    if (ids.length === 0) return undefined;
    const id = skillId ?? (ids.length === 1 ? ids[0] : undefined);
    if (!id || !ids.includes(id)) return undefined;
    return this.load(id);
  }

  private async load(id: string): Promise<SkillPackage | undefined> {
    const skillDir = join(this.rootDir, id);
    let versions: string[];
    try {
      versions = (await readdir(skillDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return undefined;
    }
    const enabled: Array<{ version: string; order: number[] }> = [];
    for (const version of versions) {
      const versionDir = join(skillDir, version);
      let manifest: { enabled?: boolean } = {};
      try {
        manifest = JSON.parse(await readFile(join(versionDir, "manifest.json"), "utf8")) as {
          enabled?: boolean;
        };
      } catch {
        // 没有 manifest = 默认启用
      }
      if (manifest.enabled === false) continue;
      enabled.push({ version, order: versionOrder(version) });
    }
    if (enabled.length === 0) return undefined;
    enabled.sort((a, b) => compareOrder(a.order, b.order));
    const chosen = enabled[enabled.length - 1]; // 最高启用版本
    const versionDir = join(skillDir, chosen.version);
    let body: string;
    try {
      body = await readFile(join(versionDir, "SKILL.md"), "utf8");
    } catch {
      return undefined; // 目录存在但没有 SKILL.md = 无效版本
    }
    return {
      id,
      version: chosen.version,
      contentHash: createHash("sha256").update(body, "utf8").digest("hex"),
      body,
      sourceDir: versionDir,
    };
  }
}

// "0.10.0" → [0,10,0]；非数值段按 0 处理，保留段数便于比较
function versionOrder(version: string): number[] {
  return version.split(".").map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareOrder(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
