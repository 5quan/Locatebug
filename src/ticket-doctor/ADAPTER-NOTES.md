# ADAPTER-NOTES —— DiagnosisEngine 端口 ↔ Pi Agent SDK 0.84.2 映射笔记

> 本文件是 skill「Adapter anchoring」要求的映射产物：**写适配器之前先写它**，且每个结论都标了出处（安装包 dist 或源码树 `D:\project\agent\源码\pi`，两者同为 v0.84.2）。
> 评审通过后才有 `pi-adapter.ts`。SDK 升级时按 skill 三步协议先重验本表。

## 0. 权威依据

| 事实 | 出处 |
|---|---|
| deepseek 认证走 `DEEPSEEK_API_KEY` 环境变量（自动发现） | `packages/ai/src/env-api-keys.ts:87`（`getApiKeyEnvVars` 的 envMap） |
| 内置模型目录 | `@earendil-works/pi-ai/dist/providers/data/deepseek.json` → **deepseek-v4-flash / deepseek-v4-pro** |
| `getModel` | `@earendil-works/pi-ai` 导出 `getBuiltinModel`（`providers/all`）；`compat.getModel` 已标 deprecated |
| TypeBox | `@earendil-works/pi-ai` 主入口重导出 `Type` / `Static` / `TSchema`（`dist/index.d.ts:1-2`）——**不需要直接依赖 typebox** |
| `CreateAgentSessionOptions` 全 13 字段 | 源码 `packages/coding-agent/src/core/sdk.ts:38-87` |
| 全手动装配模式 | `examples/sdk/12-full-control.ts`（ModelRuntime + 手写 ResourceLoader + SettingsManager.inMemory） |
| 系统提示词覆盖 | `examples/sdk/03-custom-prompt.ts`（`DefaultResourceLoader` 的 `systemPromptOverride`）；本适配器采用 example 12 的手写 ResourceLoader `getSystemPrompt`，等价且无发现逻辑 |
| `prompt()` 返回时机 | `agent-session.ts`：`prompt` 等整轮 settle 后返回；流式增量走 `subscribe`（`message_update`） |
| 终态锚 | `AgentSessionEvent`：`agent_end` 带 `willRetry`（非终态）；**`agent_settled` 才是真正结束**（`core/agent-session.ts:141`） |
| `Usage` 字段形状 | `packages/ai/src/types.ts:370`：**`{input, output, cacheRead, cacheWrite, ...}`——不是 inputTokens/outputTokens**（修正 skill 参考文档的表述） |
| `ToolDefinition.execute` | `core/extensions/types.ts:449-509`：`(toolCallId, params, signal, onUpdate, ctx)` → `{content, details, usage?, terminate?}`；`signal` 可能为 undefined |
| 参数校验分工 | `prepareArguments` 是校验前的规范化 shim（`packages/agent/src/agent-loop.ts:586`）；真正的 schema 校验在 pi-ai `validateToolArguments` |

## 1. 端口映射总表

| 本项目契约 | SDK 落点 |
|---|---|
| `DiagnosisEngine.run(task, signal)` | 每个 run：`createAgentSession(...)` 建一个会话 → `session.prompt(工单上下文)` → `session.subscribe()` 归一化事件 → 结束 `session.dispose()`。**SDK 的 agent loop 承担多轮循环** |
| "模型决策" | 不再由脚本给出，而是 SDK loop 中模型的**工具调用行为**：调 `query_logs` = call_tool 决策；调 `submit_report` = respond 决策（见 §3 决定 1） |
| 工具 | `defineTool` 包 `query_logs`（包 `LogSource`）与 `submit_report`（收 `DiagnosisReport`） |
| 取消 | `AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])` → abort 时调 `session.abort()`；abort 透传进工具 `execute` 的 signal |
| 用量 | `agent_end` 的 messages 里最后一条 assistant 的 `usage`（`{input, output}` → `usage_reported` 的 `inputTokens/outputTokens`）。**deepseek 路径可能缺 usage（skill verification-log 观察 2）→ 容忍 undefined** |
| 错误 → `RunErrorCode` | 见 §4 表 |
| 会话隔离 | `SessionManager.inMemory(cwd)`：纯内存、不落盘（`session-manager.ts:1568`，persist=false 已源码确认）；落库由我们自己的 RunLog 负责（阶段 3） |
| 安全 | `noTools: "builtin"` 禁掉 read/bash/edit/write；全手动 `ResourceLoader`（无 AGENTS.md/扩展/技能发现）；settings 内存化（compaction 关、重试开 maxRetries=2） |

## 2. SDK 事件 → 产品 AgentEvent 归一化表

原始 SDK 事件不出本文件（skill 铁律）。`tool_execution_start/end` 的时序差由适配器自记时间戳补 `durationMs`（SDK end 事件不带耗时）。

| SDK 事件 | 产品事件 |
|---|---|
| `tool_execution_start`(query_logs) | `decision_made(call_tool query_logs)` + `tool_started` |
| `tool_execution_end`(query_logs) | `tool_completed(success\|error)` + `observation_added` |
| `tool_execution_start`(submit_report) | （不发，等 end——避免用空报告发 respond 决策） |
| `tool_execution_end`(submit_report, 成功) | `decision_made(respond, report)` |
| `agent_end` | 内部记录 usage + stopReason（不发产品事件；有 willRetry 时不是终态） |
| `agent_settled` | drain 循环的结束条件（不发产品事件） |
| `message_update`（text_delta 等） | v1 忽略（产品事件无文本增量；报告经 submit_report 结构化提交，无需流式文本） |
| `auto_retry_*` / `compaction_*` / `queue_update` / `entry_*` | 忽略：SDK 自动重试对我们透明（settings 里 maxRetries=2），失败最终体现在 `agent_end.stopReason` |

## 3. 关键设计决定

1. **报告经 `submit_report` 工具提交，不解析自由文本**。TypeBox schema 强制 `status/hypotheses/evidence/suggestedNextSteps` 结构，校验失败 SDK 会把错误回给模型重试——比"提示词约定 JSON + 解析 + 失败重试"可靠。
2. **证据反编造核验**：模型引用的 `excerpt` 必须能在真实查询结果中（大小写不敏感）命中。命中 → 补全真实 provenance/时间/级别；未命中 → `source` 标 `unverified` 且该假设置信度强制降为 `low`。直接落实"结论可信"需求。
3. **空转守卫**：`query_logs` 参数与上一次完全相同（JSON 相等）→ `session.abort()` + `run_failed(no_progress)`。与假引擎语义一致。
4. **迭代预算**：`query_logs` 成功发起次数 > `maxIterations`（默认 6）→ abort + `run_failed(budget_iterations)`。注：SDK 拥有轮次，我们以"查询工具发起次数"近似迭代数。
5. **超时**：`AbortSignal.timeout(timeoutMs)`（默认 120s）与调用方 signal 组合；超时终止映射 `budget_timeout`，调用方取消映射 `run_cancelled`——两者必须可区分（分别挂监听）。
6. **终态优先级**：`report 已提交` > `no_progress` > `budget_iterations` > `timeout` > `调用方取消` > `promptError` > `stopReason=error(provider_unavailable)` > `未提交报告(runtime_error)`。
7. **认证双保险**：`DEEPSEEK_API_KEY` 环境变量自动发现 + 显式 `modelRuntime.setRuntimeApiKey("deepseek", key)`（key 存在时）。key 本体不进适配器日志。

## 4. 错误归一化表

| 来源 | 判定 | RunErrorCode | 可重试性 |
|---|---|---|---|
| 调用方 signal | caller 取消 | `run_cancelled`（不算失败） | — |
| 超时信号 | timeout 分支 | `budget_timeout` | — |
| 空转 | 同参重复查询 | `no_progress` | — |
| 预算 | 查询次数超限 | `budget_iterations` | — |
| 工具抛错（日志源） | tool isError | 不终止 run，作为 error observation 交还模型；模型应走 partial | 模型决策 |
| stopReason=error（provider 402/5xx 等，SDK 重试耗尽后） | stopReason | `provider_unavailable` | 可重试类（重试已由 SDK settings 执行过） |
| prompt() 抛异常 | promptError | `runtime_error` | 不可重试（适配器 bug 类） |
| 正常结束但没交报告 | 终态兜底 | `runtime_error`（"模型未提交诊断报告"） | 提示词侧治理 |

## 5. 已知缺口与风险

- ~~deepseek `usage` 可能 undefined（skill 已知缺口）~~ **2026-09-06 真机更新**：deepseek-v4-flash + 0.84.2 路径下 `agent_end` 携带完整 usage（一次实跑 inputTokens=4703 / outputTokens=325），该缺口在当前基线不复现，适配器仍保留 undefined 容忍。
- 结束判定双保险：优先 `agent_settled`；若 `prompt()` 已返回但 settled 未到，以 `promptDone && pending 空` 兜底退出——极端情况下可能晚一拍拿到最后事件，真机验证时专项确认。
- ~~提示词敏感：小模型可能跳过工具直接文本回复~~ 真机两次实跑模型均先查日志、均经 submit_report 交卷，未复现；提示词已显式点名工具，保持为风险观察项。
- **status 判定方差（2026-09-06 已治理）**：真机首日用同一工单跑出 complete/partial 两种判定（第二次把"inventory-service.log 不存在"写进假设正文却未走 partial）。已在系统提示词与 submit_report 字段描述中写入硬规则：**尝试获取过某份材料但未成功 → 必须 partial + missingMaterial 逐项列出；查询成功但结果为空不算缺失；禁止用正文叙述代替 partial**。重跑验证见 §6。
- `getBuiltinModel` 泛型要求字面量类型，动态 provider/modelId 传参需收窄 cast，运行时以 undefined 检查兜底。

## 6. 验证方式（对应 skill Development sequence 第 6 步）

1. **结构**：`npx tsc --noEmit` + 原 6 条 fake 测试零回归。
2. **真机**：`npm run doctor:real`（deepseek-v4-flash 真实调用）：事件流过 `assertRunInvariants`、事件类型序列符合 §2 表、报告可提取且每个证据 provenance 非空。
3. **golden 对比**：fake（`npm run doctor:demo`）与 real 的事件类型序列对照，两者完整路径均为 `run_started → decision_made → tool_started → tool_completed → observation_added → decision_made(respond) → usage_reported → run_completed`。语义不一致时改适配器，不改契约。

## 7. 材料源扩展：代码工具（2026-09-06 阶段 4a）

- **契约**（另一会话先行定义）：`CodeSource.search/read → CodeSnippet[]`，意图（`CodeSearchIntent`/`CodeReadIntent`）**不含版本**——版本钉死在 CodeSource 构造上，模型不能翻任意版本；工单带 `commit` 才启用（`PiDiagnosisOptions.codeSource` 支持按工单构造的工厂）。
- **实现**：`GitCodeSource` 用 `git grep -n -F` / `git show rev:path`，execFile 无 shell（无注入面），路径校验拒绝 `..`/绝对路径/反斜杠，结果限 50 条/200 行/单行 2000 字符。
- **踩坑**：`git grep` 输出带 rev 前缀（`HEAD:path:line:text`，三段冒号，不是两段）；**无命中时退出码为 1**——必须当作空结果而不是错误。
- **归一化**：`search_code`/`read_code` 与 `query_logs` 同表映射；`observation_added` 用 `QueryObservation` 判别联合（kind: logs/code_search/code_read）；观察按 `toolCallId` 建 Map（真机见过并行工具调用，"最后一个"不可靠）。
- **预算**：代码工具独立计数（默认 10 次 → `budget_tools`），与日志预算分开；**预算透明化**——真机发现模型不知道预算会把次数烧光被硬刹车掐死（run_failed 无报告），把预算数字写进系统提示词后，同一工单在预算内交卷（3 次日志 + 7 次代码 → partial 报告、0 未核实证据）。
- **核验**：日志条目与代码行统一进证据池（`{source, text}`），submit_report 的 excerpt 命中任一即算核实——代码证据 provenance 形如 `git-code-source@<commit> | path#L行号`。
