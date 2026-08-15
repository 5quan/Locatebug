// 工具：agent 的"手和脚"。
// 模型只能"请求"调用工具，真正执行的是我们在这里写的代码。
// 想加新能力，就往 tools 数组里再塞一项即可。

import { readFile , readdir} from "node:fs/promises";
await readdir(".")   // → ["agent.ts", "llm.ts", "tools.ts", ...]
import type { ToolDef } from "./llm.ts";

// 一个可执行工具 = 定义(告诉模型怎么用) + run(真正干活)
export interface Tool {
  def: ToolDef;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export const tools: Tool[] = [
  {
    def: {
      type: "function",
      function: {
        name: "get_current_time",
        description: "返回当前时间（ISO 8601 格式）",
        // 无参数：properties 为空对象
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    run: () => new Date().toISOString(),
  },

  {
    def: {
      type: "function",
      function: {
        name: "read_file",
        description: "读取一个文本文件的内容。path 是相对于项目根目录的路径。",
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
      const path = String(args.path ?? "");
      return await readFile(path, "utf-8");
    },
  },
  {
    def: {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出目录中的文件和子目录。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要列出的目录路径" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
run: async (args) => {
  const path = String(args.path ?? "");
  const files = await readdir(path);  // 拿到文件名数组
  return files.join("\n");            // 拼成多行文本
},  }
];
