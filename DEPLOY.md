# 部署指南（DEPLOY）

三种部署形态按投入递增：本机试用 → 内网单实例（systemd）→ Docker 单机（compose）。核心服务都是同一个进程模型：飞书机器人走长连接**出站**，不需要公网入口；HTTP API 无鉴权，默认只绑 `127.0.0.1`，永不直接对外。

## 0. 通用前置

| 事项 | 说明 |
|---|---|
| Node.js ≥ 24 | 原生 TS 类型剥离，无需编译；Node 22 需加 `--experimental-strip-types` |
| git | 代码源工具（`git grep/show <sha>`）依赖；对 bare 镜像仓可用 |
| 模型凭证 | `DEEPSEEK_API_KEY`（fake 引擎可先不配）；真机单次诊断约 5K tokens |
| 业务仓库镜像 | 建议bare 仓 + 宿主机 crontab `git fetch`（每分钟），不要挂开发工作区 |
| 日志源 | 过渡期：日志平台按服务同步 `<服务名>.log` 到约定目录；正式：实现 SLS/ELK 的 `LogSource` 适配器 |
| 测试环境 | 浏览器复现需要可重置数据的测试环境（Playwright 驱动待实现，见 ROADMAP） |

## 1. systemd（内网单实例 VM，推荐首选）

```ini
# /etc/systemd/system/ticket-doctor.service
[Unit]
Description=ticket-doctor feishu bot
After=network-online.target

[Service]
WorkingDirectory=/srv/locatebug/pi-demo
EnvironmentFile=/srv/locatebug/pi-demo/.env
ExecStart=/usr/bin/node src/ticket-doctor/feishu-bot.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

要点：`.env`（600 权限）放凭证；`.runs/` 与仓库镜像放本地盘；升级 = `git pull` + `systemctl restart`。需要 HTTP API 时再起一个同款 unit 跑 `server.ts`（不同 Port）。

## 2. Docker compose（单机）

文件：`Dockerfile`（node:24-slim + git，非 root 运行）+ `docker-compose.yml`。

```bash
cp .env.example .env          # 填凭证；容器内路径以挂载点为准
docker compose build
docker compose up -d doctor-api   # 仅 HTTP 接入面（映射到宿主机 127.0.0.1:7777）
docker compose up -d              # 或 API + 飞书机器人一起跑
```

| 挂载/卷 | 用途 | 说明 |
|---|---|---|
| `runs` 命名卷 → `/app/.runs` | 运行 JSONL + 幂等 claim | **必须持久化**；两个服务共享同一卷是安全的（claim 是本地卷上的原子文件创建，同工单只会执行一次） |
| `/srv/mirrors` → `/srv/mirrors:ro` | 业务仓库 bare 镜像 | `.env` 里 `DOCTOR_REPOS={"backend":"/srv/mirrors/backend.git",...}` |
| `./skills` → `/app/skills` | 诊断 Skill | 用 bind mount 可不重建镜像就上新版本 |
| `/srv/logs` → `/app/samples` | FileLogSource 日志 | `<服务名>.log` 约定格式 |

- `doctor-api` 在 compose 里设了 `HOST=0.0.0.0`（容器内必须监听非回环），但端口只映射到宿主机 `127.0.0.1:7777`——对外仍需带鉴权的反代。
- 镜像内已放开 git `safe.directory`（仅容器内生效），挂载进来的仓库属主与容器用户不一致也能读。
- 升级：`docker compose build && docker compose up -d`；`.runs` 在卷里不受影响。
- 未来接 Playwright 驱动：把 Dockerfile 基座换成 `mcr.microsoft.com/playwright:<版本>-noble`，其余层不变。

## 3. 形态选择

- **单实例是当前设计假设**：幂等 claim 靠本地文件原子创建、每个 run 一个 JSONL。不要把 `.runs` 放 NFS 多实例共享（原子性不可靠）；吞吐不够时先把 claim/runlog 迁到数据库，再谈横向扩。
- 云效 webhook 接入、报告投递状态机（P4）落地前，HTTP API 只建议在内网/本机使用。

## 4. 上线前建议补齐的两件事

1. **无终态 run 清扫**：进程崩溃会留下没有终态事件的 run 文件；重启后同 requestKey 重投会 duplicate 指向死 run。上线真实用户前加一个启动时清扫（标记 failed 或允许 reclaim）。
2. **Playwright 驱动**：`browser-runner.ts` 与计划白名单已就绪，缺 `playwright-driver.ts`（实现 `BrowserDriver` 接口）。

## 5. 验证清单（部署后）

```bash
# fake 引擎全链路（零模型成本）
curl -s -X POST http://127.0.0.1:7777/api/tickets -H 'content-type: application/json' \
  -d '{"ticketId":"BUG-1024","title":"下单接口批量 500","description":"10:02 起正常下单即可复现","service":"checkout-service","occurredAt":1788660120000,"commit":"HEAD"}'
curl -s http://127.0.0.1:7777/api/runs                       # 看终态
curl -s http://127.0.0.1:7777/api/runs/<runId>/events        # 审计事件流
curl -s http://127.0.0.1:7777/api/runs/<runId>/comment       # 备注预览
```

飞书侧：测试群 @机器人 发工单描述 → 收到"已受理" → 收到报告；重发同一条消息应返回 duplicate（不重复诊断）。
