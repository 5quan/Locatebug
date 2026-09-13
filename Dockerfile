# ticket-doctor 运行镜像：Node 24（原生 TS 类型剥离，无需编译步骤）+ git（代码源工具依赖）。
# 将来接入 Playwright 浏览器驱动时，只需把基座换成
#   mcr.microsoft.com/playwright:<版本>-noble
# （自带浏览器与系统依赖，Node 也在），其余层不变，git 安装行保留。

FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖再拷源码：锁文件不变时命中层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY skills ./skills
COPY samples ./samples

# 非 root 运行。挂载进容器的仓库镜像属主不可控（常见 root:root），
# 用 GIT_CONFIG_GLOBAL 指向镜像内配置放开 safe.directory（仅容器内生效）。
ENV NODE_ENV=production \
    GIT_CONFIG_GLOBAL=/app/.gitconfig \
    DOCTOR_SKILLS_DIR=/app/skills \
    DOCTOR_LOG_DIR=/app/samples
RUN printf '[safe]\n\tdirectory = *\n' > /app/.gitconfig \
 && useradd --create-home doctor \
 && mkdir -p /app/.runs \
 && chown -R doctor:doctor /app
USER doctor

EXPOSE 7777

# 默认入口 = HTTP 接入面；飞书机器人服务在 compose 里用 command 覆盖
CMD ["node", "src/ticket-doctor/server.ts"]
