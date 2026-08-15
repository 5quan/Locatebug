# pi-demo 路线图

## 定位

用 TS + 原生 `fetch`（零依赖）亲手搭最小 agent，目标是搞懂 agent 的设计与实现，而不是复刻 pi/dsh。

## 已完成 ✅

- [x] 核心循环 `step()`：问模型 → 调工具 → 回填 → 再问
- [x] 标准四件套工具：`read` / `write` / `edit` / `bash`
- [x] key 写入本地 `src/config.ts`
- [x] 一次性问答入口 `main.ts`

## 待做（按优先级）

1. [ ] **会话存盘** —— 把 messages 存盘，下次续聊（多轮 / 重复对话）
2. [ ] **多 agent** —— 两个 agent（研究员 + 执行者）消息传递协作
3. [ ] **路径安全校验** —— read/write/edit 限制在项目目录内
4. [ ] **事件流** —— 同步 step 改成发事件（pi/dsh 的核心机制）
5. [ ] **流式输出**
6. [ ] **上下文压缩 compaction**

## 概念备忘

- **loop vs ReAct**：loop 是控制流（机制）；ReAct 是推理范式；function calling 是 ReAct 的现代版（dsh 的循环类就叫 `ReactLoopAgent`）。
- **工具 = def（给模型看）+ run（给机器跑）**，`name` 是接头暗号；模型永远拿不到 `run`，执行权始终在代码手里。
- **工具分四档**：感知（只读）/ 写文件 / 执行程序 / 外部系统；`bash` 是"通用兜底"，高频+安全动作值得做成专用工具。
- **记忆两层**：进程内 = `messages` 数组；重复对话 = 存盘读回。
- **多 agent 不是新原语**：同一循环跑两个实例 + 消息传递。

## 服务端架构（面向公司内部多人）

### 架构图

```
[用户 浏览器/CLI]
      │  SSE / WebSocket（流式）
      ▼
[接入层]  鉴权(内部SSO) + 限流 + 路由
      ▼
[任务队列]  长任务排队 / 取消 / 重试
      ▼
[Agent Worker 池]  每个活跃会话跑一个 step() 循环
      │
      ├──▶ [模型网关]      API key / 路由 / 成本计量 / 限流
      ├──▶ [工具执行层·沙箱] read/write/bash，每用户隔离
      │
      ▼
[会话存储]  session-id → messages，事件溯源，可恢复
[可观测]    日志 / 追踪 / 每用户成本
```

### 三条原则

1. **会话 = 状态，必须落盘可恢复**（多人服务会崩、会扩缩容）。pi/dsh 都因此选事件溯源。
2. **沙箱隔离是第一分水岭**：单用户 pi 随便 bash；多人服务里一个用户读到另一个用户的文件 = 事故。dsh 用 e2b + 原生 landlock 做沙箱，不用 TS。
3. **无状态 API + 持久会话 + 异步 worker**：HTTP 请求只"往某会话塞一条 user 消息"，真正的 step() 循环在 worker 里异步跑，结果 SSE 流回。

### 与 dsh 包结构的对照

| 架构层 | dsh 对应包 |
|---|---|
| 接入层 | `packages/api/gateway` |
| 会话存储 | `packages/session` |
| 沙箱 | `packages/e2b` + `native/landlock-run` |
| 模型网关 | `packages/llm` |
| 鉴权 | `packages/credentials` + `packages/interaction` |
| 多 agent | `packages/subagent`、`workflow`、`goal` |

### 语言选择

- agent 是 I/O 密集（99% 等网络），语言几乎不影响能力。
- 内部工具：团队会哪门用哪门；无强烈理由就 TS。
- 证据：dsh 本身是多人服务端 harness，选 TS；但沙箱等系统级能力用原生代码，与主语言无关。
