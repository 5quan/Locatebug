# pi-demo 路线图

## 定位

用 TS + 原生 `fetch`（零依赖）亲手搭最小 agent，目标是搞懂 agent 的设计与实现，而不是复刻 pi/dsh。

## 能力分层地图

```text
接入层：HTTP / CLI
编排层：多 agent（subagent / goal / workflow）
核心循环：step()
上下文装配层：RAG 注入 + compaction
工具层：def + run（read/write/edit/bash/search + MCP）
会话存储：JSONL 事件日志
```

- **MCP 属于工具层**：把外部系统的能力注册成工具（def + run 的远程版）
- **RAG 检索做成 tool**：模型决定何时查、查什么、怎么用结果
- **多 agent 属于编排层**：同一循环跑多个实例，通过消息/结果协作


## 已完成 ✅

- [X] 核心循环 `step()`：问模型 → 调工具 → 回填 → 再问
- [X] 标准四件套工具：`read` / `write` / `edit` / `bash`
- [X] key 写入本地 `src/config.ts`
- [X] 一次性问答入口 `main.ts`
- [X] 会话存盘（JSONL 事件溯源）
  - `.sessions/<id>.jsonl`，第一行 header
  - 每行事件带 `seq` / `time`
  - `message` / `title` / `sandbox/mode` 三种事件
  - `readSession()` 一次 fold 出 `messages` / `title` / `sandboxMode`
  - CLI：默认新建，`--session <id>` 续聊，`--list` 列表
  
  - [X] HTTP 后端 + 纯 HTML/JS 前端
    - 会话列表 / 新建 / 切换 / 聊天
    - API：`/api/sessions`、`/api/sessions/:id/messages`
  
  - [X] 流式输出
    - `llm.ts`：`callLlmStream` 解析 SSE
    - `agent.ts`：`step` 支持 `StepHandlers`
    - `server.ts`：`POST /api/sessions/:id/stream`
    - 前端：token 实时显示 + 工具执行过程实时显示
- [X] 基础路径安全：`read` / `write` / `edit` 限制在项目目录内（仅字符串级，还没有 sandbox 模式与审批）
  
    
    
  
    
    
    
    
  
    
    
  
    
    
    
    

## 当前进行

- [ ] **工具层重构 + RAG search 工具**
  1. 工具注册从"静态数组"改成"可注册"
  2. 新增 `search` 工具：模型决定何时检索
  3. 新增 `retriever.ts`：查询本地知识库，返回片段 + 来源
  4. 检索过程作为 tool message 自然落盘

## 已设计但暂缓 ⏸️

- [ ] 权限控制完整化：三档 sandbox 模式 + approval + OS 级 sandbox
  - 数据基础已有：`sandbox/mode` 事件 + `readSession()` fold
  - 暂不实现：工具层按模式判断、切换 API、页面选择器

> 权限先不做，默认放开

## 待做（按依赖顺序）

1. [ ] **工具可扩展化** —— 静态 tools 数组改成可注册
2. [ ] **RAG tool** —— search 工具 + retriever + knowledge/
3. [ ] **MCP 最小版** —— 连接 MCP server，注册为本地工具
4. [ ] **上下文压缩 compaction** —— RAG/多 agent 吃 token，需要摘要替代旧历史
5. [ ] **多 agent** —— 主 agent + 子 agent，复用同一 step()
6. [ ] **事件流升级** —— handler 轻量版升级为持久化 run 事件
7. [ ] **审批 approval**
8. [ ] **OS 级 sandbox**

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

| 架构层   | dsh 对应包                                          |
| -------- | --------------------------------------------------- |
| 接入层   | `packages/api/gateway`                            |
| 会话存储 | `packages/session`                                |
| 沙箱     | `packages/e2b` + `native/landlock-run`          |
| 模型网关 | `packages/llm`                                    |
| 鉴权     | `packages/credentials` + `packages/interaction` |
| 多 agent | `packages/subagent`、`workflow`、`goal`       |

### 语言选择

- agent 是 I/O 密集（99% 等网络），语言几乎不影响能力。
- 内部工具：团队会哪门用哪门；无强烈理由就 TS。
- 证据：dsh 本身是多人服务端 harness，选 TS；但沙箱等系统级能力用原生代码，与主语言无关。
