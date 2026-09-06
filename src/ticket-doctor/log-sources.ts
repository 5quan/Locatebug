// 阶段 1 的日志源适配器：从本地样例日志文件检索。
//
// 为什么用文件而不是把日志硬编码在引擎里：LogSource 是端口，阶段 4 换成真实日志平台
// （阿里云 SLS / ELK）适配器时，引擎和 Core 一行都不用改——这就是 skill「SDK 是适配器」
// 在工具侧的体现。
//
// 文件约定：<dir>/<service>.log，行格式为 `ISO时间 \t LEVEL \t 消息`。
// 查询语义：时间窗内 + 任一关键词命中（大小写不敏感）；按时间倒序，最多 maxEntries 条。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry, LogQueryIntent, LogSource } from "./contracts.ts";

export class FileLogSource implements LogSource {
  readonly name: string;
  private readonly dir: string;
  private readonly maxEntries: number;

  // 不用参数属性语法：Node 原生类型剥离不支持（见 fake-engine.ts 的说明）
  constructor(dir: string, maxEntries = 20) {
    this.dir = dir;
    this.maxEntries = maxEntries; // 工具结果是不可信输入：条数也必须限长
    this.name = `file-log-source(${dir})`;
  }

  async query(intent: LogQueryIntent, signal: AbortSignal): Promise<LogEntry[]> {
    signal.throwIfAborted();

    const file = join(this.dir, `${intent.service}.log`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      // 文件不存在按业务错误抛出，而不是静默返回空列表——
      // "服务不存在"和"服务没有错误日志"是两种完全不同的诊断结论
      throw new Error(`日志文件不存在：${file}（服务 ${intent.service} 是否拼写正确？）`);
    }

    const keywords = intent.keywords.map((k) => k.toLowerCase());
    const entries: LogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 < 0 || tab2 < 0) continue; // 不符合行格式的行直接跳过
      const time = Date.parse(line.slice(0, tab1));
      if (Number.isNaN(time)) continue;
      if (time < intent.timeWindow.from || time > intent.timeWindow.to) continue;
      const level = line.slice(tab1 + 1, tab2);
      const message = line.slice(tab2 + 1);
      if (keywords.length > 0 && !keywords.some((k) => message.toLowerCase().includes(k))) {
        continue;
      }
      entries.push({ time, level, message });
    }

    entries.sort((a, b) => b.time - a.time); // 最近的在前：诊断时最先看到最新现场
    return entries.slice(0, this.maxEntries);
  }
}
