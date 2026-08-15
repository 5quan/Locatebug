// 工具：agent 的"手和脚"。
// 标准四件套（对齐 pi 默认）：read / write / edit / bash
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { ToolDef } from "./llm.ts";

// 一个可执行工具 = 定义(告诉模型怎么用) + run(真正干活)
export interface Tool {
  def: ToolDef;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export const tools: Tool[] = [
  // read：读文件
  {
    def: {
      type: "function",
      function: {
        name: "read",
        description: "读取一个文本文件的内容。path 是文件路径。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要读取的文件路径" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    run: async (args) => {
      return await readFile(String(args.path ?? ""), "utf-8");
    },
  },

  // write：创建或覆盖文件
  {
    def: {
      type: "function",
      function: {
        name: "write",
        description: "把内容写入一个文件（不存在则创建，存在则覆盖）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要写入的文件路径" },
            content: { type: "string", description: "要写入的文本内容" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    run: async (args) => {
      await writeFile(String(args.path ?? ""), String(args.content ?? ""));
      return "已写入";
    },
  },

  // edit：把文件里的一段旧文本替换成新文本
  {
    def: {
      type: "function",
      function: {
        name: "edit",
        description: "把文件里的一段旧文本替换成新文本。old_string 必须和文件里现有内容完全一致。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要编辑的文件路径" },
            old_string: { type: "string", description: "要被替换的原文（必须完全匹配）" },
            new_string: { type: "string", description: "替换后的新内容" },
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    run: async (args) => {
      const path = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const content = await readFile(path, "utf-8");
      if (!content.includes(oldStr)) {
        throw new Error(`找不到要替换的片段: ${oldStr}`);
      }
      const updated = content.replace(oldStr, newStr);
      await writeFile(path, updated);
      return "已替换";
    },
  },

  // bash：执行 shell 命令
  {
    def: {
      type: "function",
      function: {
        name: "bash",
        description: "在系统 shell 中执行一条命令并返回输出。Windows 下是 cmd（用 dir 不用 ls）。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的 shell 命令" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    run: (args) => {
      const result = spawnSync(String(args.command ?? ""), {
        shell: true,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return [result.stdout, result.stderr].filter(Boolean).join("\n");
    },
  },
];
