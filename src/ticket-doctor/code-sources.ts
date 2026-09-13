// CodeSource 端口的 Git 实现（契约见 contracts.ts：search/read 都返回按行的 CodeSnippet）。
//
// 版本绑定：GitCodeSource.create() 在构造时用 `git rev-parse` 把引用解析成完整 commit SHA
// 并钉死——之后本实例所有的 search/read 都读这一个版本。传入 "HEAD" 时如果每次查询都
// 重新解析，仓库一变同次诊断就会读到不同版本；解析成 SHA 后该问题不存在。
// 模型的 search/read 意图里没有版本参数——它不能翻任意版本，只能看工单说的那一版。
//
// 多仓路由：MultiRepoCodeSource 按 intent.repoId 把意图分发给对应仓库的 CodeSource
// （前端/后端分仓分别解析、分别记录，证据里逐条带 repoId@sha）。
//
// 安全约束：execFile 无 shell（pattern/path 都是 argv，不是命令行字符串）；
// 路径白名单校验（拒绝绝对路径/反斜杠/../控制字符）；结果限条数/限行数/限字节。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CodeReadIntent,
  CodeSearchIntent,
  CodeSnippet,
  CodeSource,
} from "./contracts.ts";

const execFileP = promisify(execFile);

export interface GitCodeSourceOptions {
  commit?: string; // 钉住的版本；缺省 "HEAD"
  repoId?: string; // 业务仓标识（前后端分仓时区分证据归属），默认 "app"
  maxSnippets?: number; // search 返回条数上限，默认 50
  maxLines?: number; // read 单次行数上限，默认 200
}

// 工具结果按不可信输入处理：单行超长也要截（极端情况一行几 MB 的 minified 文件）
const MAX_SNIPPET_CHARS = 2_000;

/** 把可解析引用（HEAD/短哈希/分支名）解析成完整 commit SHA；解析失败抛业务错误。 */
export async function resolveRepoSha(repoDir: string, rev: string): Promise<string> {
  const ref = rev.trim() || "HEAD";
  if (!/^(?:[0-9a-fA-F]{7,40}|HEAD)$/.test(ref)) {
    throw new Error(`非法 commit 引用：${rev}`);
  }
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoDir, "rev-parse", `${ref}^{commit}`],
      { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`rev-parse 返回异常：${sha}`);
    }
    return sha;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
    throw new Error(
      `无法解析代码版本 ${ref}（仓库 ${repoDir}）：${tail || e.message || "git 命令失败"}`,
    );
  }
}

export class GitCodeSource implements CodeSource {
  readonly repoId: string;
  private readonly repoDir: string;
  private readonly rev: string;
  private readonly maxSnippets: number;
  private readonly maxLines: number;
  private resolvedSha?: string;
  private resolving?: Promise<string>;

  constructor(repoDir: string, opts: GitCodeSourceOptions = {}) {
    const commit = opts.commit ?? "HEAD";
    if (!/^(?:[0-9a-fA-F]{7,40}|HEAD)$/.test(commit)) {
      throw new Error(`非法 commit 引用：${commit}`);
    }
    this.repoDir = repoDir;
    this.rev = commit;
    this.repoId = opts.repoId ?? "app";
    this.maxSnippets = opts.maxSnippets ?? 50;
    this.maxLines = opts.maxLines ?? 200;
  }

  /**
   * 推荐 construction 路径：立即解析 SHA（运行开始时钉版本）。
   * 解析失败（坏引用/不存在的 commit）在这里就抛，不让模型跑到一半才发现版本是坏的。
   */
  static async create(repoDir: string, opts: GitCodeSourceOptions = {}): Promise<GitCodeSource> {
    const source = new GitCodeSource(repoDir, opts);
    await source.ensureResolved();
    return source;
  }

  /** 解析并缓存完整 SHA（幂等；已解析直接返回）。 */
  async ensureResolved(): Promise<string> {
    if (this.resolvedSha) return this.resolvedSha;
    this.resolving ??= resolveRepoSha(this.repoDir, this.rev);
    this.resolvedSha = await this.resolving;
    return this.resolvedSha;
  }

  get name(): string {
    const short = (this.resolvedSha ?? this.rev).slice(0, 10);
    return `git-code-source@${short}(${this.repoDir})`;
  }

  get revision(): string | undefined {
    return this.resolvedSha;
  }

  private validatePath(path: string): string {
    const p = path.trim();
    if (!p || p.length > 512) throw new Error("read_code：path 非法（空或超长）");
    if (p.includes("\\") || p.startsWith("/")) {
      throw new Error("read_code：path 必须是相对路径且用 / 分隔");
    }
    if (p.split("/").includes("..") || p.includes(":") || /[\x00-\x1f]/.test(p)) {
      throw new Error(`read_code：path 含非法段：${p}`);
    }
    return p;
  }

  private async git(args: string[], signal: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileP("git", ["-C", this.repoDir, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      return stdout;
    } catch (err) {
      const e = err as { code?: number; killed?: boolean; stderr?: string; message?: string };
      if (e.killed) throw new Error("代码查询被中止");
      if (typeof e.code === "number") {
        // 保留退出码（调用方靠它区分"无命中"和"真失败"），附上 stderr 末行便于定位
        const tail = (e.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
        e.message = tail ? `${e.message}：${tail}` : e.message;
        throw e;
      }
      throw new Error(e.stderr ?? e.message ?? "git 命令失败");
    }
  }

  private static toSnippet(line: string): CodeSnippet | undefined {
    // git grep -n <rev> 输出形如 rev:path:line:text（三段冒号）；text 里可能再有冒号，取剩余全部
    const c1 = line.indexOf(":");
    const c2 = c1 >= 0 ? line.indexOf(":", c1 + 1) : -1;
    const c3 = c2 >= 0 ? line.indexOf(":", c2 + 1) : -1;
    if (c1 < 0 || c2 < 0 || c3 < 0) return undefined;
    const path = line.slice(c1 + 1, c2);
    const lineno = Number(line.slice(c2 + 1, c3));
    const text = line.slice(c3 + 1);
    if (!path || !Number.isInteger(lineno)) return undefined;
    return { path, line: lineno, text };
  }

  async search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    const pattern = intent.pattern.trim();
    if (!pattern || pattern.length > 200) {
      throw new Error("search_code：pattern 必须是 1~200 个字符");
    }
    const rev = await this.ensureResolved();
    // -F 固定字符串匹配（契约约定：子串匹配，不是正则）
    let stdout: string;
    try {
      stdout = await this.git(["grep", "-n", "-F", "-e", pattern, rev, "--", "."], signal);
    } catch (err) {
      if ((err as { code?: number }).code === 1) return []; // git grep 约定：无命中 = 退出码 1
      throw err;
    }
    const snippets = stdout
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map(GitCodeSource.toSnippet)
      .filter((s): s is CodeSnippet => s !== undefined)
      .filter((s) => (intent.glob ? s.path.includes(intent.glob) : true))
      .slice(0, this.maxSnippets)
      .map((s) => ({
        ...s,
        text: s.text.length > MAX_SNIPPET_CHARS ? s.text.slice(0, MAX_SNIPPET_CHARS) + "…" : s.text,
      }));
    return snippets;
  }

  async read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    const path = this.validatePath(intent.path);
    const rev = await this.ensureResolved();
    const content = await this.git(["show", `${rev}:${path}`], signal);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const startLine = Math.max(1, Math.floor(intent.startLine ?? 1));
    const endLine = Math.min(
      lines.length,
      Math.floor(intent.endLine ?? startLine + this.maxLines - 1),
    );
    const snippets: CodeSnippet[] = [];
    for (let line = startLine; line <= endLine && snippets.length < this.maxLines; line++) {
      const text = lines[line - 1] ?? "";
      snippets.push({
        path,
        line,
        text: text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) + "…" : text,
      });
    }
    return snippets;
  }
}

/** 多仓路由：按 intent.repoId 分发；只有一个仓时它就是缺省目标。 */
export class MultiRepoCodeSource implements CodeSource {
  readonly repoId: string;
  private readonly sources: Map<string, CodeSource>;
  private readonly defaultRepoId: string;

  constructor(sources: Array<CodeSource & { repoId: string }>) {
    if (sources.length === 0) throw new Error("MultiRepoCodeSource 需要至少一个代码源");
    this.sources = new Map(sources.map((s) => [s.repoId, s]));
    this.defaultRepoId = sources[0].repoId;
    this.repoId = sources.map((s) => s.repoId).join("+");
  }

  get name(): string {
    return `multi-repo(${[...this.sources.values()].map((s) => s.name).join(", ")})`;
  }

  get revision(): string | undefined {
    return undefined; // 版本逐仓记录，取数请用 pick(repoId).revision
  }

  /** 解析意图对应的代码源（缺省 = 唯一仓 / 第一个仓）。 */
  pick(repoId?: string): CodeSource {
    if (!repoId) return this.sources.get(this.defaultRepoId)!;
    const picked = this.sources.get(repoId);
    if (!picked) {
      throw new Error(
        `未知的 repoId：${repoId}（本次可用：${[...this.sources.keys()].join(", ")}）`,
      );
    }
    return picked;
  }

  search(intent: CodeSearchIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    return this.pick(intent.repoId).search(intent, signal);
  }

  read(intent: CodeReadIntent, signal: AbortSignal): Promise<CodeSnippet[]> {
    return this.pick(intent.repoId).read(intent, signal);
  }
}
