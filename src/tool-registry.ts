// 工具注册表：统一管理可供 agent 使用的工具。
// 工具可以来自本地内置能力，后续也可以来自 RAG、MCP 等动态来源。
import type { ToolDef } from "./llm.ts";

// 一个可执行工具 = 定义（告诉模型怎么用）+ run（真正干活）
export interface Tool {
  def: ToolDef;
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(initialTools: Tool[] = []) {
    for (const tool of initialTools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    const name = tool.def.function.name;
    if (this.tools.has(name)) {
      throw new Error(`工具名称重复：${name}`);
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDef[] {
    return [...this.tools.values()].map((tool) => tool.def);
  }
}
