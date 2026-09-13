// 引擎组装工厂：server.ts 与 feishu-bot.ts 共用，避免两个入口的接线各自漂移。
//
// 组装规则：
// - 生成器：fake（零成本）或 pi（Pi SDK + DeepSeek）；
// - 审计（DOCTOR_AUDIT）：
//     off  → 不审计（行为与旧版一致）；
//     fake → 确定性审计（FakeDiagnosisAuditor，机械信号，不烧 token，可离线演示全回流闭环）；
//     on   → 真实引擎配 PiDiagnosisAuditor（独立模型调用）；fake 引擎配确定性审计。
// - 审计开启时统一包上 AuditedDiagnosisEngine（回流预算/熔断/token 预算/降级兜底都在里面）。

import type { BrowserDriver, DiagnosisEngine, LogSource } from "./contracts.ts";
import { AuditedDiagnosisEngine } from "./audited-engine.ts";
import { FakeDiagnosisAuditor } from "./fake-auditor.ts";
import { FakeDiagnosisEngine } from "./fake-engine.ts";
import { PiDiagnosisAuditor } from "./pi-auditor.ts";
import { PiDiagnosisEngine, type PiDiagnosisOptions } from "./pi-adapter.ts";

export type AuditMode = "on" | "off" | "fake";

export interface EngineStackParams {
  kind: "fake" | "pi";
  logSource: LogSource;
  auditMode: AuditMode;
  codeSource?: PiDiagnosisOptions["codeSource"];
  browserDriver?: BrowserDriver;
  provider?: string;
  modelId?: string;
  apiKey?: string;
}

export function createEngineStack(params: EngineStackParams): DiagnosisEngine {
  const base: DiagnosisEngine =
    params.kind === "fake"
      ? new FakeDiagnosisEngine({ logSource: params.logSource })
      : new PiDiagnosisEngine({
          logSource: params.logSource,
          ...(params.codeSource ? { codeSource: params.codeSource } : {}),
          ...(params.browserDriver ? { browserDriver: params.browserDriver } : {}),
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.apiKey ? { apiKey: params.apiKey } : {}),
        });

  const auditor =
    params.auditMode === "off"
      ? undefined
      : params.auditMode === "fake" || params.kind === "fake"
        ? new FakeDiagnosisAuditor()
        : new PiDiagnosisAuditor({
            ...(params.provider ? { provider: params.provider } : {}),
            ...(params.modelId ? { modelId: params.modelId } : {}),
            ...(params.apiKey ? { apiKey: params.apiKey } : {}),
          });

  if (!auditor) return base;
  return new AuditedDiagnosisEngine({ generator: base, auditor });
}

/** 解析 DOCTOR_AUDIT 环境变量（on / off / fake；非法值按 on 处理并告警）。 */
export function auditModeFromEnv(raw: string | undefined): AuditMode {
  if (raw === "off" || raw === "fake") return raw;
  if (raw === undefined || raw === "" || raw === "on") return "on";
  console.error(`DOCTOR_AUDIT=${raw} 不是合法值（on/off/fake），按 on 处理`);
  return "on";
}
