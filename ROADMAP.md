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

### 工单预检 Agent（ticket-doctor）：阶段 1 完成

测试提 bug 到开发响应之间存在时间空白，而"让 AI 先过一遍"已经是开发拿到工单后的习惯动作。本产品把这一步前置：工单提交时自动触发诊断 Agent，拉取相关服务的错误日志，做初步根因分析，把带证据的预检报告写回工单备注。按 skill（pi-coding-agent）的第一性原理方法开发；Pi Agent SDK 作为诊断引擎端口的真实适配器在阶段 2 接入。

当前阶段状态：

- [x] 领域契约（`src/ticket-doctor/contracts.ts`）：TicketTask / Evidence（带 provenance）/ DiagnosisReport / Decision / 产品级 AgentEvent / LogSource 与 DiagnosisEngine 端口。
- [x] 纯函数 Core（`src/ticket-doctor/core.ts`）：事件回放重建状态、报告提取、事件流不变量校验、工单备注渲染。
- [x] 假诊断引擎（`src/ticket-doctor/fake-engine.ts`）：脚本化"模型"驱动最小循环；空转守卫（no_progress）与迭代预算（budget_iterations）已生效；查询失败产出 partial 报告而非 run_failed。
- [x] 假日志源（`src/ticket-doctor/log-sources.ts` + `samples/`）：按服务名 + 时间窗 + 关键词检索本地样例日志，证据自动附 provenance 与长度截断。
- [x] 测试：`npm test`（完整路径 / partial / 空转守卫 / 迭代预算 / 回放 / 不变量共 6 组断言）。
- [x] 演示：`npm run doctor:demo`（complete 与 partial 两条路径）。

后续阶段（对应 skill 的 Development sequence）：

- [ ] 阶段 2：先写适配器映射笔记，再用 Pi Agent SDK 实现 DiagnosisEngine（`createAgentSession` + `defineTool` + 事件归一化），fake 与 real 用同一套事件语义对比。
- [ ] 阶段 3：Runtime——Run 生命周期、RunLog（JSONL）落库、超时与取消、ticketId 幂等。
- [ ] 阶段 4：真实集成——HTTP 模拟云效工单触发、真实日志源适配器、工单备注写回。
- [ ] 阶段 5：golden runs 回归语料与产品验收（skill 退出清单逐条对应测试）。

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
