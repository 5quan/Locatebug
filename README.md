# pi-demo：一个最小可跑的 agent

用 TypeScript + 原生 `fetch`（零依赖）手写一个能对话、会调工具的 agent。
代码刻意做小，目的是看清 agent 的本质，而不是复刻 pi。

## 目录结构

```
pi-demo/
├─ package.json      —— 无依赖，只有 start / chat 两个脚本
├─ .gitignore        —— 忽略 node_modules 和 src/config.ts（防泄漏 key）
├─ README.md         —— 本文件
└─ src/
   ├─ config.ts      —— 把 API key 写死在这里（本地文件，别提交）
   ├─ llm.ts         —— 唯一和模型说话的地方（原生 fetch 调 DeepSeek）
   ├─ tools.ts       —— 工具定义 + 实现（agent 的"手和脚"）
   ├─ agent.ts       —— agent 循环（心脏）
   ├─ main.ts        —— 一次性问答入口
   └─ repl.ts        —— 交互式对话入口（跑一次，然后一直输入一直答）
```

## 怎么跑

### 1. 放 key

把 key 写进 `src/config.ts`：

```ts
export const DEEPSEEK_API_KEY = "sk-你的key";
```

也可以不写，改用环境变量 `DEEPSEEK_API_KEY`（环境变量优先）。

### 2. 交互式对话（推荐）

```powershell
npm run chat
```

启动后像聊天一样：输入一行，回车，等回复。输入 `/quit` 或直接回车退出。
对话历史存在内存里，所以它能"记住"你前面说过的话。

### 3. 一次性问答（原来的方式）

```powershell
node src/main.ts "现在几点？顺便读一下 README.md"
```

### 可选环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `DEEPSEEK_MODEL` | 模型名 | `deepseek-chat` |
| `DEEPSEEK_BASE_URL` | 接口地址（可指向本地 Ollama 等） | `https://api.deepseek.com` |

## agent 的四个概念，分别对应到代码

回忆 README 里的四个关键词，这里各有一个"最小实现"：

1. **消息数组（上下文窗口）** —— `agent.ts` 里的 `messages` 数组。
   对话就是不断往数组里 append，每轮把整包发给模型。
   没有魔法，上下文窗口 = 你塞进这个数组的所有东西。

2. **工具调用** —— `tools.ts` 定义工具，`llm.ts` 把 `tools` 随请求发出去，
   模型返回 `tool_calls`，`agent.ts` 的 `executeTool` 替它执行，再把结果
   以 `{ role: "tool", tool_call_id, content }` 塞回数组。

3. **循环** —— `agent.ts` 里的 `step` 函数：
   问模型 → 有没有工具调用？有就执行、继续；没有就结束。

4. **系统提示** —— 它是对话数组里的第一条消息。

## 阅读顺序建议

1. 先看 `agent.ts` 里的 `step`，只有几十行，是核心。
2. 再看 `llm.ts`，看一次请求到底发了什么、收回什么。
3. 再看 `repl.ts`，看"连续对话"只是复用同一个 `messages` 数组。
4. 最后看 `tools.ts` 和 `main.ts`。

跑 `npm run chat`，先问"现在几点"，再问"刚才几点了"，你会发现第二句它记得第一句——
因为两次都往同一个 `messages` 数组里 append。

## 练习：怎么加一个工具

在 `tools.ts` 的数组里再加一项即可，例如"计算两个数的和"：

```ts
{
  def: {
    type: "function",
    function: {
      name: "add",
      description: "计算两个整数的和",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
  },
  run: (args) => String(Number(args.a) + Number(args.b)),
},
```

然后问它："帮我算 123 加 456"，模型就会自己决定去调 `add`。
