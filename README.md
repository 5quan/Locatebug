# pi-demo

一个使用 TypeScript、Node.js 原生 HTTP 和原生 `fetch` 编写的最小 Agent 学习项目。

项目目标不是复刻完整框架，而是亲手实现并理解这些核心机制：

- 模型如何通过循环持续调用工具。
- 工具定义和真实执行函数如何连接。
- 会话如何使用 JSONL 事件日志持久化和恢复。
- 网页如何通过 SSE 显示模型和工具的实时输出。
- 长上下文如何通过 compaction 转换成摘要 checkpoint。
- 多个 Agent 如何通过独立上下文和结果传递进行协作。

参考项目：

- [`earendil-works/pi`](https://github.com/earendil-works/pi)
- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)

## 当前能力

- DeepSeek OpenAI-compatible 模型调用。
- 非流式和 SSE 流式模型响应。
- 最小 Agent 循环：模型 → 工具 → 工具结果 → 模型。
- 可扩展的 `ToolRegistry`。
- 内置 `read` / `write` / `edit` / `bash` 工具。
- CLI 多会话和网页版多会话。
- JSONL 追加式事件日志。
- 会话标题、sandbox mode 数据和连续 `seq` 校验。
- 自动上下文压缩和滚动摘要。
- 同一会话进程内并发保护。

RAG 和 MCP 已决定暂不实现。当前下一条主线是多 Agent。

## 架构

```text
CLI / HTTP / SSE
       │
       ▼
runUserTurn()
       │
       ├── readSession()：恢复原始消息和模型上下文
       ├── compactIfNeeded()：必要时生成摘要 checkpoint
       ▼
step()
       │
       ├── callLlmStream()
       ├── ToolRegistry.getDefinitions()
       ├── 执行模型请求的工具
       └── 把 tool result 放回 messages 后继续循环
       │
       ▼
appendMessage()：只追加本轮新增消息
```

分层关系：

```text
接入层：CLI / HTTP / SSE
编排层：多 Agent（下一阶段）
核心循环：step()
上下文层：compaction
工具层：ToolRegistry + 内置工具
会话层：JSONL 事件日志
```

## 目录

```text
public/
  index.html          网页界面

src/
  agent.ts            Agent 核心循环 step()
  compaction.ts       上下文测量、摘要和压缩范围选择
  config.ts           本地 API key 配置，不提交到 Git
  llm.ts              非流式和流式模型请求
  main.ts             CLI 入口
  server.ts           Node 原生 HTTP/SSE server
  session-store.ts    JSONL 会话事件存储和 replay
  tool-registry.ts    工具注册表
  tools.ts            read/write/edit/bash 工具
  turn.ts             CLI 和 HTTP 共用的一轮请求逻辑

.sessions/            本地会话日志，不提交到 Git
ROADMAP.md             项目进度和下一阶段设计
Target.md              compaction 当前实现与目标设计
```

`src/repl.ts` 是废弃入口，不建议使用。

## 环境要求

- Node.js 24 或支持直接运行 TypeScript 的兼容版本。
- npm。
- DeepSeek API key，或其他兼容当前接口的服务。

安装依赖：

```powershell
npm install
```

推荐通过环境变量配置 API key：

```powershell
$env:DEEPSEEK_API_KEY = "你的 API key"
```

也可以在本地 `src/config.ts` 中配置；该文件已被 `.gitignore` 忽略。

可选环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `src/config.ts` 中的值 | 模型 API key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 使用的模型 |
| `PORT` | `3000` | 网页服务端口 |
| `COMPACTION_THRESHOLD_TOKENS` | `32000` | 触发上下文压缩的估算 token 阈值 |
| `COMPACTION_KEEP_RECENT_TOKENS` | `8000` | 压缩后近期原文的保留量 |

`COMPACTION_KEEP_RECENT_TOKENS` 必须小于 `COMPACTION_THRESHOLD_TOKENS`。

## 运行

### 网页版

```powershell
npm run server
```

浏览器打开：

```text
http://localhost:3000
```

网页支持：

- 新建、切换和读取会话。
- 实时显示模型文字。
- 显示工具开始、参数和结果预览。
- 一轮结束后从 JSONL 日志重新读取正式历史。

### CLI 新建会话

```powershell
npm start -- "分析一下 src/agent.ts"
```

### CLI 续聊

```powershell
npm start -- --session <会话id> "继续刚才的任务"
```

### 列出会话

```powershell
npm start -- --list
```

### 类型检查

```powershell
npx tsc --noEmit
```

## Agent 调用流程

一次普通请求的主要流程：

1. `runUserTurn()` 调用 `readSession()` 恢复会话。
2. 新的 user 消息先追加到 JSONL 日志。
3. `compactIfNeeded()` 检查当前模型上下文长度。
4. `step()` 把 system、历史和当前 user 消息发送给模型。
5. 如果模型返回工具调用，注册表找到对应的 `run()` 并执行。
6. 工具结果作为 `tool` 消息放回上下文，再次调用模型。
7. 模型不再调用工具时结束。
8. 本轮新增的 assistant/tool 消息追加到日志。

关键点：`step()` 会原地向 `messages` 数组追加消息；存储层只保存本轮新增部分，不能把整个历史重复写入。

## 会话日志

会话保存在：

```text
.sessions/<session-id>.jsonl
```

第一行是 session header，后续每行一个事件。目前主要事件：

- `message`：user、assistant 或 tool 消息。
- `title`：会话标题，latest-wins。
- `sandbox/mode`：权限模式数据，目前尚未真正执行。
- `compaction`：已提交的上下文摘要和近期消息起点。

日志是唯一真源，只追加、不整体重写。网页展示使用完整原始消息；模型上下文由日志投影得到。

## Compaction

当估算上下文达到阈值时：

1. 从安全的 `user` 边界选择旧消息范围。
2. 使用非流式模型生成结构化摘要。
3. 验证摘要非空且确实缩短上下文。
4. 成功后追加单个 `compaction` 事件。
5. 后续模型请求使用“摘要 checkpoint + 近期原文”。

原始消息不会被删除。摘要失败时不提交压缩事件，本轮继续使用原始上下文。

详细设计见 [Target.md](./Target.md)。

## 多 Agent 下一阶段

第一版计划采用主 Agent 保持控制的“Agent as tool”模式：

- 主 Agent 通过 `subagent` 委派一个自包含任务。
- 子 Agent 使用独立消息数组、system prompt 和工具注册表运行自己的 `step()`。
- 子 Agent 只把最终结果返回主 Agent，中间上下文不污染父会话。
- 第一版提供 researcher 和 executor profile。
- 深度限制为 1，先串行执行，再增加并行、持久 child 和 workflow。

完整调研与分阶段计划见 [ROADMAP.md](./ROADMAP.md)。

## 当前限制

- `bash` 仍是高权限工具，没有 OS 级 sandbox。
- `sandbox/mode` 目前只记录数据，尚未限制工具执行。
- 没有 approval 流程。
- 同会话互斥只是单进程内存状态，不支持多 worker。
- assistant/tool 消息仍在一轮完整结束后批量落盘，中途崩溃可能丢失本轮部分执行记录。
- token 使用零依赖估算，不是模型官方 tokenizer。
- compaction 是简化版单事件提交，不是完整可恢复事务。

不要把当前实现直接作为不可信用户的公网代码执行服务。

## 文档

- [ROADMAP.md](./ROADMAP.md)：真实进度、多 Agent 调研和后续路线。
- [Target.md](./Target.md)：简化 compaction 与目标 compaction 的对照。
- [HANDOVER.md](./HANDOVER.md)：历史交接记录，其中早期状态可能已经过期。
