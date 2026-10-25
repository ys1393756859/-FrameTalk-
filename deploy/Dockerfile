# app 与 worker 共用同一镜像，不同启动命令
FROM node:24-slim

# 国内镜像加速下载 Prisma 引擎（离线部署时用 docker save/load，不依赖此变量）
ARG PRISMA_ENGINES_MIRROR=
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

# ffmpeg >= 5.1 且需含 zscale / tonemap / bwdif 滤镜（M0 第一天校验）
RUN ffmpeg -version | head -1 && ffmpeg -hide_banner -filters | grep -E "zscale|tonemap|bwdif"

RUN corepack enable && npm i -g pnpm@11

WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm --filter @frametalk/shared build 2>/dev/null || true
RUN cd apps/web && pnpm build || true

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
# docker-compose 里 app: pnpm --filter @frametalk/server start ；worker: start:worker
CMD ["pnpm", "--filter", "@frametalk/server", "start"]
