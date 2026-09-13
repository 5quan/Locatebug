# ticket-doctor：让 AI 在 Bug 工单提交时先完成一轮预检

`ticket-doctor` 是一个面向研发协作场景的工单预检 Agent。它把开发接手 Bug 后常做的“先让 AI 看一遍”前置到工单提交时：自动读取问题上下文，检索日志与指定版本代码，形成带来源证据的根因假设和下一步建议，为开发填补“测试提单 → 开发响应”之间的时间空白。

这是一个个人能力展示项目，目前已经跑通本地可演示的诊断后端，但还不是已经接入企业生产环境的成品。真实云效/钉钉接入、真实日志平台和自动回写仍在后续计划中。

## 为什么做这个项目

在实习中我观察到两个同时存在的现象：

1. 测试提交 Bug 后，开发往往要过几个小时甚至一天才开始排查；
2. 开发真正接手时，通常会先把报错、日志或代码交给 AI 做一轮初步分析。

因此，这个项目尝试把第二步提前到第一步发生的时刻：

```text
传统流程：提交 Bug ──等待──> 开发接手 ──> AI 初查 ──> 人工深入定位
目标流程：提交 Bug ──> Agent 自动预检 ──等待──> 开发带着证据和假设接手
```

它不替代开发做最终判断，而是提前完成材料收集和第一轮排查，减少重复搜索、上下文切换和无证据猜测。

## 当前完成到哪一步

当前主线已完成到“阶段 4a：本地诊断闭环”，核心后端链路已经建立：

| 能力 | 状态 | 当前实现 |
| --- | --- | --- |
| 标准工单输入 | 已完成 | `TicketTask` 统一描述标题、正文、服务、发生时间和代码版本 |
| Agent 根因分析 | 已完成 | 基于 Pi Agent SDK 和 DeepSeek 的真实诊断引擎，另有零成本 Fake Engine |
| 日志检索 | 本地版已完成 | 从样例日志按服务、时间窗、关键词查询；真实 SLS/ELK 尚未接入 |
| 代码检索 | 已完成 | 通过 `git grep` / `git show` 检索指定 commit，返回文件、行号和原文 |
| 引用准确性约束 | 已完成 | 模型引用必须在实际工具结果中命中，否则标记 `unverified` 并将置信度降为 `low` |
| 运行时治理 | 已完成 | 幂等受理、超时与预算、取消传播、空转保护、唯一终态 |
| 审计与回放 | 已完成 | 每次运行以 append-only JSONL 记录完整事件，可重建状态和报告 |
| HTTP 接入面 | 模拟版已完成 | 提供提交工单、查询进度、查看事件和生成备注文本的本地 API |
| 飞书群聊机器人 | 代码已完成，待真机验收 | 官方 SDK 长连接接收群聊 @消息，异步诊断后回复原消息，无需公网地址 |
| 云效/钉钉 Webhook 适配 | 未完成 | 当前 API 接收项目自定义 JSON，不是企业平台原生 payload |
| 真实日志平台 | 未完成 | 仍需实现 SLS/ELK 等 `LogSource` 适配器和权限控制 |
| 自动返回报告 | 飞书版待真机验收 | 飞书机器人已接入原消息回复；云效/钉钉工单回写尚未实现 |
| 可视化工作台 | 未完成 | 当前以 HTTP API、事件日志和命令行为主 |
| 回归评测体系 | 未完成 | 单元测试已建立，golden runs、提示词版本化和质量指标仍待补齐 |

需要特别说明：虽然 `TicketTask` 和代码源已经支持 `commit`，当前 HTTP 入参转换还没有把 `commit` 传入运行时，因此通过 Server 提交时暂时不会启用代码工具；真实演示脚本已经可以按 `HEAD` 或 commit 运行代码检索。这是接入层下一步需要补齐的明确缺口。

## 一次诊断如何运行

```text
工单 / HTTP 请求
       │
       ▼
TicketDoctorRuntime
  ├─ 原子幂等受理：ticketId → runId
  ├─ 组合超时与取消信号
  └─ 逐事件持久化
       │
       ▼
DiagnosisEngine（Fake / Pi SDK）
  ├─ query_logs：按服务和时间窗查日志
  ├─ search_code：在指定版本搜索代码
  ├─ read_code：读取文件与精确行号
  └─ submit_report：提交结构化诊断报告
       │
       ▼
证据核验 → JSONL 审计日志 → 工单备注文本
```

外部依赖都放在端口后面：

- `DiagnosisEngine` 隔离 Agent SDK 和模型供应商；
- `LogSource` 隔离本地文件、SLS 或 ELK；
- `CodeSource` 隔离 Git 仓库的检索方式；
- Core 只定义合法事件、证据和报告，不依赖任何 SDK。

因此，替换日志平台或模型时不需要改写诊断领域逻辑。

## 我重点解决的工程问题

### 1. 让引用可核验，而不是让模型“看起来有依据”

所有日志和代码证据都携带 provenance。模型提交报告时，系统会把引用片段与真实查询结果交叉核验：

- 命中：补全真实来源、时间、日志级别或代码位置；
- 未命中：来源标为 `unverified`，相关假设强制降为低置信度；
- 材料不足：输出 `partial` 和缺失材料，不伪装成完整诊断。

代码读取被钉在工单指定 commit 上，避免用当前工作区代码解释历史版本故障。

### 2. 把 Agent 运行变成可治理的后台任务

模型循环具备最大迭代数、工具调用次数、总超时和无进展保护。无论引擎正常完成、超时、取消、抛错，Runtime 都保证留下唯一终态事件，避免任务永久处于“运行中”。

同一 `ticketId` 通过独占创建运行日志实现原子 claim；即使并发提交或进程重启，也不会重复诊断同一张工单。

### 3. 把诊断和平台副作用解耦

诊断结果先进入事件日志，再由展示或投递层消费。未来即使工单回写失败，也只需要重试投递，不需要重新调用模型，更不会把“诊断失败”和“报告没送达”混成同一种状态。

### 4. 保留完整审计链路

`.runs/<run-id>.jsonl` 是一次诊断的唯一事实源，记录模型决策、工具调用、查询观察、用量和终态。进度、最终报告和工单备注都从事件投影得到，没有额外的可变状态源。

## 快速运行

环境要求：Node.js 24 或支持直接运行 TypeScript 的兼容版本。

```powershell
npm install
```

### 零模型成本演示

```powershell
npm run doctor:demo
```

### 真实模型演示

设置 DeepSeek API Key：

```powershell
$env:DEEPSEEK_API_KEY = "你的 API Key"
npm run doctor:real
```

也可以在项目根目录创建不会提交到 Git 的 `.env`：

```text
DEEPSEEK_API_KEY=你的 API Key
```

真实演示会使用本地样例日志和当前仓库代码，输出事件时间线、诊断报告、证据核验结果与工单备注预览。

### 启动 HTTP 服务

推荐先用 Fake Engine 验证接入流程：

```powershell
$env:DOCTOR_ENGINE = "fake"
npm run doctor:server
```

默认监听 `http://127.0.0.1:7777`。提交一张模拟工单：

```powershell
$body = @{
  ticketId   = "BUG-1024"
  title      = "下单接口批量 500"
  description = "10:02 起正常下单即可复现"
  service    = "checkout-service"
  occurredAt = 1788660120000
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:7777/api/tickets `
  -ContentType "application/json" `
  -Body $body
```

查询运行结果：

| 接口 | 用途 |
| --- | --- |
| `POST /api/tickets` | 异步受理工单，重复提交返回 `accepted=false` |
| `GET /api/runs` | 查看所有诊断运行及其终态 |
| `GET /api/runs/:id/events` | 查看完整事件流，用于审计和回放 |
| `GET /api/runs/:id/progress` | 查看由事件投影出的当前进度 |
| `GET /api/runs/:id/comment` | 获取准备写回工单的备注文本 |

### 本地启动飞书群聊机器人

在飞书开放平台创建企业自建应用并完成以下配置：

1. 添加机器人能力，并把机器人加入测试群；
2. 权限管理中申请“获取群聊中 @ 机器人的消息”和“以应用的身份发消息”；
3. 事件与回调中选择“使用长连接接收事件”；
4. 添加事件 `im.message.receive_v1`；
5. 创建并发布一个可供测试企业使用的应用版本。

复制 `.env.example` 为 `.env`，然后填写本地凭证：

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
DEEPSEEK_API_KEY=sk-xxx

# 可选：默认分别使用 samples/ 和当前项目仓库
DOCTOR_LOG_DIR=D:\path\to\logs
DOCTOR_REPO_DIR=D:\path\to\repository
```

先使用 Fake Engine 验证消息收发，不消耗模型额度：

```powershell
$env:DOCTOR_ENGINE = "fake"
npm run doctor:feishu
```

随后在测试群发送自由文本，例如：

```text
@ticket-doctor 下单接口批量 500，服务：checkout-service，commit: 58ed2ba
10:02 起正常下单即可复现，错误日志：InventoryClient timeout after 3000ms
```

机器人会先回复“已受理”，后台诊断完成后再回复完整报告。服务名允许自然语言描述；明确出现的 `HEAD` 或 7～40 位 Git commit 会被提取并用于固定代码版本。缺少必要材料时，Agent 应返回 `partial` 和缺失材料，而不是猜测。

同一条飞书消息以 `message_id` 生成稳定的工单 ID；如需重复测试，请发送一条新消息。第一版只支持群聊 @机器人的纯文本，不处理私聊、图片、文件或富文本消息。

## 测试

```powershell
npm test
npx tsc --noEmit
```

测试覆盖：

- 完整诊断与材料缺失路径；
- 空转、迭代预算、超时和异常终止；
- 事件顺序、唯一终态与状态回放；
- 并发及重启后的幂等受理；
- Git 代码搜索、按行读取、版本与路径安全；
- 运行进度和模型用量投影。

## 项目结构

```text
src/ticket-doctor/
  contracts.ts       领域契约：工单、证据、报告、端口和事件
  core.ts            事件回放、不变量校验、报告与备注渲染
  fake-engine.ts     确定性的 Fake Agent，用于低成本测试
  pi-adapter.ts      Pi Agent SDK 的真实诊断引擎适配器
  log-sources.ts     本地文件日志源
  code-sources.ts    固定 Git 版本的代码搜索与读取
  run-log.ts         append-only JSONL 运行日志
  runtime.ts         幂等、预算、取消、落库和终态治理
  progress.ts        从事件流投影诊断进度
  server.ts          本地 HTTP 接入和查询 API
  feishu-adapter.ts  飞书事件转换、幂等受理与回复编排
  feishu-bot.ts      飞书官方 SDK 长连接启动入口
  demo.ts            Fake Engine 演示
  demo-real.ts       真实模型演示

samples/             本地演示日志
.runs/               本地运行记录，不提交到 Git
```

进一步阅读：

- [`ONBOARDING.md`](./ONBOARDING.md)：项目设计推导与上手说明；
- [`FLOW-DESIGN.md`](./FLOW-DESIGN.md)：端到端流程与状态机；
- [`ARCH-REVIEW.md`](./ARCH-REVIEW.md)：产品缺口和后续架构选择；
- [`ROADMAP.md`](./ROADMAP.md)：阶段进度与后续路线；
- [`src/ticket-doctor/ADAPTER-NOTES.md`](./src/ticket-doctor/ADAPTER-NOTES.md)：Pi SDK 适配依据和已知风险。

## 下一步

按“先完成可用闭环，再扩展展示面”的顺序推进：

1. 修正 HTTP 入参转换，完整传递并校验 commit，同时支持真实仓库路径配置；
2. 完成飞书真机验收，并将回复投递状态持久化以支持进程重启和独立重试；
3. 接入真实 SLS/ELK 日志源，并加入最小权限、脱敏和查询审计；
4. 增加独立 `TicketReporter` 投递状态机，实现失败重试和幂等回写；
5. 建立 golden runs、提示词版本化和人工反馈指标，持续评测诊断质量；
6. 增加诊断工作台，展示实时事件、证据链、预算和最终报告。

项目最终希望形成的不是一个“会聊天的 Bug 助手”，而是一条可核验、可回放、可治理的 AI 预检流水线。

## 演进背景

本仓库最初用于学习通用 Agent 的工具循环、会话日志和上下文压缩；在完成这些基础机制后，主线收敛为 `ticket-doctor` 这一具体业务场景。旧阶段的设计记录仍保留在仓库历史和相关文档中，但不代表当前产品主线。
