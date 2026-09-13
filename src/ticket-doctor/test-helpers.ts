// 测试共享的小工具（保持各测试文件不再复制同一批桩实现）。

import type { LogEntry, LogSource } from "./contracts.ts";

// 内存日志源：不碰文件系统，测试完全确定
export function memoryLogSource(entries: LogEntry[], name = "memory-log-source"): LogSource {
  return { name, query: async () => entries };
}
