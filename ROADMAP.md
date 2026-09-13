# pi-demo 路线图

## 项目定位

使用 TypeScript、Node.js 原生能力和原生 `fetch`，从零实现一个最小但结构清晰的 Agent，用于理解 Agent 的核心循环、工具、会话、上下文压缩和多 Agent 编排。

项目不追求复刻完整的 [`pi`](https://github.com/earendil-works/pi) 或 [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，而是参考它们的设计，按依赖顺序实现最小闭环。

```text
接入层：CLI / HTTP / SSE
编排层：多 Agent（当前主线）
核心循环：step()
上下文层：compaction
工具层：ToolRegistry + read / write / edit / bash
会话层：JSONL 事件日志
```

## 状态定义

- **已完成**：代码已经存在，并通过类型检查或相应运行验证。
- **当前进行**：已经确定为下一条主线，允许包含“设计完成、代码未开始”等阶段状态。
- **明确不做**：已经决定不进入当前项目主线，不应继续出现在待办列表中。
- **未来候选**：可能有价值，但尚未承诺实现，也没有当前排期。

## 已完成

### 1. 模型调用与核心循环

- [x] `callLlm()`：非流式 OpenAI-compatible 模型请求。
- [x] `callLlmStream()`：解析模型 SSE 响应并拼接文字与工具调用。
- [x] `step()`：模型调用 → 工具执行 → 工具结果回填 → 再次调用模型。
- [x] `StepHandlers`：向上层传递 assistant 文字、工具开始和工具结果。
- [x] `runAgent()`：从空上下文运行一次独立 Agent。

### 2. 工具注册表与内置工具

- [x] `ToolRegistry`：支持注册、按名称查找和导出模型工具定义。
- [x] 默认工具注册表工厂 `createDefaultToolRegistry()`。
- [x] `read` / `write` / `edit` / `bash` 四个内置工具。
- [x] 重复工具名称检测。
- [x] `read` / `write` / `edit` 限制在项目目录内。

当前工具边界只是应用层路径检查，不等于 OS 级 sandbox；`bash` 仍具有较高权限。

### 3. 会话事件日志

- [x] `.sessions/<id>.jsonl` 追加式会话日志。
- [x] 第一行 session header，包含 version、id 和 createdAt。
- [x] 每个正文事件包含连续 `seq` 和 `time`。
- [x] `message` 事件：保存 user、assistant 和 tool 消息。
- [x] `title` 事件：latest-wins，不进入模型上下文。
- [x] `sandbox/mode` 事件：记录权限模式数据，latest-wins。
- [x] `compaction` 事件：记录摘要、近期消息起点和压缩前 token。
- [x] `readSession()`：一次 replay 派生完整会话状态。
- [x] 原始消息和模型可见上下文分离。
- [x] header、会话 id、版本和连续 seq 校验。

### 4. 公共 Turn 与 CLI

- [x] `runUserTurn()`：CLI 和 HTTP 共用的一轮执行逻辑。
- [x] system 消息不落盘，每轮重新注入。
- [x] 只追加本轮新增消息，避免重复保存全部历史。
- [x] CLI 默认创建新会话。
- [x] `--session <id>` 续聊。
- [x] `--list` 列出会话。

### 5. HTTP、网页与流式输出

- [x] Node 原生 HTTP server。
- [x] `GET /api/sessions`：列出会话。
- [x] `POST /api/sessions`：创建会话。
- [x] `GET /api/sessions/:id/messages`：读取完整原始消息。
- [x] `POST /api/sessions/:id/messages`：非流式执行一轮。
- [x] `POST /api/sessions/:id/stream`：SSE 流式执行一轮。
- [x] 单文件 HTML/JS 页面：创建、切换和连续聊天。
- [x] 网页实时显示 assistant 文字、工具开始和工具结果预览。
- [x] 同一会话进程内互斥，避免同时运行两个 turn。

### 6. 简化版 Compaction

- [x] `step()` 前估算模型上下文 token。
- [x] 通过环境变量配置触发阈值和近期保留量。
- [x] 中文字符约 1 token、其他字符约 4 字符/token 的零依赖估算。
- [x] 只从 `user` 消息边界切割，避免拆开工具调用和工具结果。
- [x] 使用非流式模型生成结构化滚动摘要。
- [x] 再次压缩时合并旧摘要与新增旧消息。
- [x] 摘要成功后追加单个 `compaction` 事件。
- [x] 原始消息永久保留，不删除、不重写。
- [x] replay 派生“摘要 checkpoint + 近期原始消息”。
- [x] 摘要失败或验证失败时不提交事件，并继续使用原上下文。

当前实现与产品级目标设计的差异见 [Target.md](./Target.md)。

### 7. 项目文档

- [x] [README.md](./README.md)：项目架构、运行方法和当前限制。
- [x] [Target.md](./Target.md)：当前 compaction 与目标 compaction 对照。
- [x] [ROADMAP.md](./ROADMAP.md)：以当前代码为准的状态与计划。

## 当前进行

### 工单预检 Agent（ticket-doctor）：阶段 3 完成

测试提 bug 到开发响应之间存在时间空白，而"让 AI 先过一遍"已经是开发拿到工单后的习惯动作。本产品把这一步前置：工单提交时自动触发诊断 Agent，拉取相关服务的错误日志，做初步根因分析，把带证据的预检报告写回工单备注。按 skill（pi-coding-agent）的第一性原理方法开发；Pi Agent SDK 作为诊断引擎端口的真实适配器在阶段 2 接入。

当前阶段状态：

- [x] 领域契约（`src/ticket-doctor/contracts.ts`）：TicketTask / Evidence（带 provenance）/ DiagnosisReport / Decision / 产品级 AgentEvent / LogSource 与 DiagnosisEngine 端口。
- [x] 纯函数 Core（`src/ticket-doctor/core.ts`）：事件回放重建状态、报告提取、事件流不变量校验、工单备注渲染。
- [x] 假诊断引擎（`src/ticket-doctor/fake-engine.ts`）：脚本化"模型"驱动最小循环；空转守卫（no_progress）与迭代预算（budget_iterations）已生效；查询失败产出 partial 报告而非 run_failed。
- [x] 假日志源（`src/ticket-doctor/log-sources.ts` + `samples/`）：按服务名 + 时间窗 + 关键词检索本地样例日志，证据自动附 provenance 与长度截断。
- [x] 测试：`npm test`（完整路径 / partial / 空转守卫 / 迭代预算 / 回放 / 不变量共 6 组断言）。
- [x] 演示：`npm run doctor:demo`（complete 与 partial 两条路径）。
- [x] 阶段 2——Pi SDK 适配器：先写 `ADAPTER-NOTES.md` 映射笔记再实现 `pi-adapter.ts`；真机 deepseek-v4-flash 跑通（事件流过不变量校验、usage 完整、0 条未核实证据）；报告经 `submit_report` 工具提交（TypeBox 强制形状）+ 证据反编造核验；partial 判定硬规则（真机三次验证一致）。
- [x] 阶段 3——Runtime：`run-log.ts`（.runs/*.jsonl append-only 落库，wx 独占创建 = 原子幂等 claim，可回放）；`runtime.ts`（Runtime 拥有预算、引擎异常/无终态补 run_failed 留痕）；`server.ts`（POST /api/tickets 模拟云效触发，GET runs/events/comment 审计面）。测试 11/11 通过，fake 引擎 curl 冒烟全链路通过。
- [x] 阶段 4a——读代码与进度投影：契约（CodeSource 端口，版本钉死在构造上）→ `code-sources.ts`（git grep/show 实现，无 shell、限长、路径校验）→ 适配器接线（search_code/read_code 工具、QueryObservation 判别联合、证据池统一核验、代码工具独立预算 budget_tools）；`progress.ts` 进度投影（进度 = f(事件)，不新增状态源）+ GET /api/runs/:id/progress；真机验证模型主动用 search_code 定位堆栈类名、预算透明化治理（预算写进提示词，避免被硬刹车掐死）。测试 20/20 通过。

后续阶段（对应 skill 的 Development sequence）：

- [ ] 阶段 4b：真实集成——云效 webhook payload → TicketTask 适配器（含 commit 提取）、真实日志源适配器、诊断备注写回云效（或钉钉通知）。
- [ ] 阶段 5：golden runs 回归语料与产品验收（skill 退出清单逐条对应测试）。

### 工单预检 Agent：诊断审计与定向回流（2026-09-14 本轮）

针对"模型把局部证据过度归因为根因"和"整轮重试重复犯错"两个问题，落地独立审计 Agent 与程序驱动的定向回流（第三板斧"Agent 评测与调优"的审计与回流专篇在本产品的实现）。

- [x] 独立审计契约与端口：`AuditInput`（原始工单 + 待审报告 + 工具轨迹摘要 + 全部证据，刻意不含生成者中间推理）；`DiagnosisAuditor` 端口；`audit_completed` / `reflow_triggered` 事件进运行日志。
- [x] `pi-auditor.ts`：独立审计 Agent（形态二 Standalone Auditor）——对抗视角提示词（默认假设报告有问题，逐项 pass/fail + 理由，找不到问题必须明说）、TypeBox 强制的三档结论（pass/degrade/reject）+ 结构化问题清单（维度/描述/证据引用/假设定位/回流方向建议）。
- [x] `fake-auditor.ts`：确定性审计（机械信号：宣称复现但轨迹无浏览器复现记录、verified 无证据引用等），fake 引擎链路零成本跑通完整回流闭环。
- [x] `audited-engine.ts`：回流编排引擎（仍是 DiagnosisEngine，Runtime 无感知）——pass 交付 / degrade 定向降级交付 / reject 按问题类型定向回流（补证 supplement_evidence、假设修订 revise_hypothesis）；四道闸门：回流预算（默认 2 次）、失败历史注入下一轮（去重反馈）、同一维度连续两次失败熔断升级、可选 token 累计预算；超出预算不交付空结果——保留已核实结论（`mergePreserved`）与待验证项，status 兜底 partial。
- [x] `audit-actions.ts`：审计结论→程序动作的纯函数（定向降级映射、复现有效性异议强制 reproductionStatus=indeterminate、verified 门槛塌陷、corrections 全程留痕）。
- [x] 证据池跨尝试共享（`RunContext.evidenceStore`）：回流的补证进入同一池，证据 ID 全局唯一，已核实结论在降级后仍可精确追溯；`RunContext.auditFeedback` 注入生成器（去重反馈），假引擎脚本可感知。
- [x] 接线：`engine-factory.ts` 统一组装（server / feishu-bot 共用），`DOCTOR_AUDIT=on|off|fake`（默认 on）；系统提示词新增审计反馈处理规则。
- [x] 测试：`reflow.test.ts` 9 项（PASS / 补证回流 / 预算耗尽降级 / 熔断 / DEGRADE / token 预算 / 生成器失败透传 / 审计失败如实声明 / fake 集成），全套 60 项通过。真机审计（pi-auditor × 模型）待环境接入后验收。

### 工单预检 Agent：复现驱动定位 / 证据约束交付 / Skill 基础（2026-09-13 本轮）


按"浏览器复现 + 源码协同定位"目标方案完成 P0（基础补齐）、P1（证据与 Skill 基础）、P2 的离线可测部分（浏览器执行器 + 契约）。真实 Playwright 驱动、业务测试环境、反馈优化器（P3）与持久化投递（P4）未开始。

- [x] P0——基础补齐：HTTP/飞书入口 commit 透传（此前 `validateTicket` 丢弃 commit，HTTP 路径永远开不了代码工具）；`DOCTOR_REPOS` 业务仓库映射 + `prepareContext` 在运行开始把 rev 解析成完整 SHA（前后端分仓逐仓解析、逐仓记录，`MultiRepoCodeSource` 按 repoId 路由）；ticketId / requestKey / runId 身份分离（runId 由 Runtime 生成传入引擎，同一工单不同 requestKey = 两次独立运行，幂等 claim 改为 `(ticketId, requestKey)` 独占创建）；工具失败留痕（error observation + SDK 层失败补发 tool_completed）；用量改为整 run 累计；Runtime in-flight 保活句柄修复"挂死引擎等不到超时"的事件循环排空问题。
- [x] P1——证据与 Skill 基础：`evidence-store.ts`（工具执行时签发证据 ID，绑定 runId/toolCallId/版本/位置）；`report-validator.ts`（引用存在性与运行归属、版本一致性校验；强制降级规则：零有效证据→low+candidate、verified 需复现确认、reproduced 需浏览器证据、complete 需零工具失败；submit_report 草稿→校验→打回/降级循环，修订上限 2 次）；字符串匹配反编造核验下线；`skill-registry.ts`（目录布局 `<root>/<id>/<version>/SKILL.md`，sha256 内容哈希，运行开始固定版本，`skill_selected` 事件进事件流）+ 默认 Skill `skills/ticket-triage/0.1.0`。
- [x] P2（离线部分）——复现驱动定位：契约（TicketTask 增 entryUrl/预期实际结果/复现步骤/环境标识/多仓版本；受约束 `ReproductionPlan`；`BrowserRunResult` 执行状态与复现状态分离）；`browser-runner.ts`（计划白名单校验通过才开浏览器；复现状态由 assert 步骤结果推导，不信任驱动自报；驱动异常=环境阻塞；取证截断进证据池）；`BrowserDriver` 端口 + 测试用脚本化假驱动。真实 Playwright 驱动与业务测试环境接入未开始。
- [x] 测试：51 项全部通过（原 25 项适配 + 新增 evidence/validator/skill/browser 与 runId 分离测试）；`smoke/smoke.ts` 冒烟覆盖 commit 透传、skill_selected、requestKey 幂等、SHA 钉死、坏 commit fail fast。无 TypeScript 编译器可用（npm 不在环境内），未做完整类型检查，全部模块通过 Node 类型剥离语法校验。
- [x] 部署材料：`Dockerfile`（node:24-slim + git、非 root、层缓存友好的依赖安装）、`docker-compose.yml`（doctor-api / doctor-bot 双服务共享 runs 卷）、`DEPLOY.md`（systemd / Docker / 形态选择 / 验证清单）；`server.ts` 支持 `HOST` 环境变量（默认仍 127.0.0.1）。
- [ ] P2（环境部分）：接入一个可重置数据的业务测试环境 + Playwright 驱动，覆盖"前端参数错误 / 后端业务失败 / 前端展示错误"三类可控案例与登录失效、元素缺失等执行失败案例。
- [ ] P3——反馈优化：案例集（Agent 可见 / 评测器可见物理隔离）、开发反馈结构化记录、候选修订生成、新旧版本重跑对比（重跑已具备：runId 分离 + skill 版本固定）。
- [ ] P4——交付完善：报告投递状态机（pending→sending→delivered/failed 持久化）、失败重试、真实工单入口验收。

### 多 Agent：设计完成，实现未开始

当前阶段状态：

- [x] 调研 `pi` 的 subagent extension。
- [x] 调研 `dsh` 的 provider、one-shot、continuable、控制工具和 workflow 分层。
- [x] 确定采用 single-agent first，不默认启动多 Agent。
- [x] 确定不修改核心 `step()`，通过可选编排能力接入。
- [x] 确定第一版采用主 Agent 保持控制的 Agent-as-tool 模式。
- [ ] 开始第一版代码实现。

#### 第一版目标

```text
用户请求
   ↓
主 Agent step()
   ↓ 调用 subagent 工具
SubagentRunner / Provider
   ↓ 创建独立 messages 和 ToolRegistry
子 Agent step()
   ↓ 最终结果
tool result 返回主 Agent
   ↓
主 Agent 综合回答
```

第一版只实现一次性、前台、串行子 Agent：

- 主 Agent 通过 `subagent` 工具自主决定是否委派。
- 子 Agent 使用独立消息数组和独立工具注册表。
- 子 Agent 不继承父会话，主 Agent 必须传递自包含任务。
- 提供 `researcher` 和 `executor` 两种 profile。
- `researcher` 只使用只读工具；`executor` 使用执行任务需要的工具。
- 子 Agent 中间消息不进入父会话。
- 父会话只保存 subagent 工具调用和最终结果。
- 委派深度固定为 1，禁止子 Agent 继续创建子 Agent。
- 子 Agent 失败必须返回明确错误，不能伪装成成功。

#### 第一版实现清单

- [ ] 定义 `AgentProfile`：name、description、systemPrompt、工具范围、maxTurns。
- [ ] 定义最小 `SubagentProvider` / `SubagentRunner` 接口。
- [ ] 实现进程内 one-shot provider，复用现有 `step()`。
- [ ] 实现 researcher 和 executor profile。
- [ ] 注册模型可见的 `subagent` 工具。
- [ ] 将 subagent 工具只注册给主 Agent。
- [ ] 增加最大输出、单轮调用数量和失败处理。
- [ ] 验证上下文隔离、工具隔离、禁止递归和父 Agent 汇总流程。

#### 设计原则

- 多 Agent 是可选编排能力，不是默认执行架构。
- 第一版接近 `pi` 的薄扩展，不复制 `dsh` 的完整生命周期系统。
- 保留 provider 边界，未来可以增加持久或进程外实现。
- 多 Agent 是否值得继续扩展，应由目标任务的质量、token 和耗时评测决定。
- 多 Agent 并行写同一工作区前，必须先解决冲突和权限隔离。

参考：

- [pi subagent extension](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
- [dsh subagent packages](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/subagent)
- [OpenAI Agents SDK: Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

## 明确不做

以下内容已经决定不进入当前项目主线：

- **RAG search 工具**：不新增 `retriever.ts`、`knowledge/` 或 search 工具。
- **MCP 接入**：不连接 MCP server，不注册远程 MCP 工具。
- **关键词固定路由**：不通过关键词规则选择工具或 Agent。
- **完整 swarm / peer-to-peer Agent 网络**：不实现无中心、任意 Agent 互相委派的网络。
- **直接复制 dsh 多 Agent 子系统**：不在第一版实现 continuable child、Activation、完整 provider 家族和 workflow runtime。

这些项目如未来重新进入范围，需要新的明确决策，不能因为仍显示在旧文档中而视为待办。

## 未来候选

以下能力目前没有排期，只保留演进方向。

### 多 Agent 后续能力

- 子 Agent 执行事件：`subagent_start` / `subagent_end` / `subagent_error`。
- SSE 和网页显示子 Agent 状态、任务、工具调用和 usage。
- 子 Agent 独立 JSONL 会话、parent session 和 delegation depth。
- 子 Agent transcript 查看、取消和失败恢复。
- 后台运行、稳定 child id 和后续消息。
- 有界并行 fan-out/fan-in。
- 固定 chain、review loop 和代码编排 workflow。
- 结构化子 Agent 输出和中心验证者。

### 会话与可靠性

- assistant/tool 消息增量落盘。
- turn/tool 状态机。
- 持久化 run 事件流。
- 残缺日志恢复、幂等写入和更完整的事务边界。
- projection cache，避免会话列表完整 replay 每个文件。
- 精确 token meter 和模型溢出恢复。
- compaction start/summary/end 事务及 replacement message。

### 权限与服务端工程

- 将 `sandbox/mode` 真正接入工具执行。
- approval 流程。
- OS 级 sandbox。
- 用户/工作区隔离。
- 无状态 API、任务队列和 Agent worker。
- 取消、超时、重试和跨进程会话锁。
- 模型网关、usage、成本、日志和 tracing。

## 长期服务端参考架构

```text
[浏览器 / CLI]
       │ SSE / WebSocket
       ▼
[接入层：鉴权、限流、路由]
       ▼
[任务队列：排队、取消、重试]
       ▼
[Agent Worker / Multi-Agent Orchestrator]
       ├── 模型网关
       ├── 工具执行沙箱
       └── 子 Agent provider
       ▼
[会话事件存储 + projection]
       ▼
[日志、追踪、token 与成本统计]
```

长期原则：

1. 会话和子 Agent 状态需要落盘并可恢复。
2. API 层保持无状态，长任务由 worker 执行。
3. 权限由执行层强制，不能只依赖 system prompt。
4. 多 Agent 必须有中心汇总和结果验证。
5. 多 Agent 的收益必须通过目标任务评测证明，而不是通过 Agent 数量判断。
