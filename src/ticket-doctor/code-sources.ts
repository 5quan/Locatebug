// CodeSource 端口的 Git 实现（契约见 contracts.ts：search/read 都返回按行的 CodeSnippet）。
//
// 版本绑定：commit 在构造时钉死（工单带版本 → 调用方构造钉住该版本的实例），
// 模型的 search/read 意图里没有版本参数——它不能翻任意版本，只能看工单说的那一版。
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
  maxSnippets?: number; // search 返回条数上限，默认 50
  maxLines?: number; // read 单次行数上限，默认 200
}

// 工具结果按不可信输入处理：单行超长也要截（极端情况一行几 MB 的 minified 文件）
const MAX_SNIPPET_CHARS = 2_000;

export class GitCodeSource implements CodeSource {
  readonly name: string;
  private readonly repoDir: string;
  private readonly rev: string;
  private readonly maxSnippets: number;
  private readonly maxLines: number;

  constructor(repoDir: string, opts: GitCodeSourceOptions = {}) {
    const commit = opts.commit ?? "HEAD";
    if (!/^(?:[0-9a-fA-F]{7,40}|HEAD)$/.test(commit)) {
      throw new Error(`非法 commit 引用：${commit}`);
    }
    this.repoDir = repoDir;
    this.rev = commit;
    this.maxSnippets = opts.maxSnippets ?? 50;
    this.maxLines = opts.maxLines ?? 200;
    this.name = `git-code-source@${commit}(${repoDir})`;
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
    // -F 固定字符串匹配（契约约定：子串匹配，不是正则）
    let stdout: string;
    try {
      stdout = await this.git(["grep", "-n", "-F", "-e", pattern, this.rev, "--", "."], signal);
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
    const content = await this.git(["show", `${this.rev}:${path}`], signal);
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
