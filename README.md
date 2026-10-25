<div align="center">

# 帧言 · FrameTalk

**自托管、帧精确的影视 / 广告 / 动画团队审片与批注工具**

上传素材 → 自动转码 → 在线逐帧批注 → 版本迭代 → 团队审阅 → 导出修改清单

[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-f69220)](https://pnpm.io)
[![Docker](https://img.shields.io/badge/docker-compose%20%E4%B8%89%E5%AE%B9%E5%99%A8-2496ed)](./deploy)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

帧言（FrameTalk）是一个可完全私有化部署的音视频审片协作平台。Docker Compose 三容器（API / 转码 Worker / PostgreSQL）即可运行，不依赖 Redis、对象存储和 nginx，单机可支撑约 100 人团队、20 人同时在线审阅。

<!-- 建议在此放置产品截图（审阅页 / 多版本对比 / 管理后台），图片放 docs/screenshots/ -->

## 功能特性

### 🎬 素材与转码

- **断点续传上传**：tus 协议 50MB 分块，支持拖拽与文件夹上传，上传前校验项目权限与磁盘剩余空间
- **自动转码代理**：1080p H.264（CRF20 / GOP≈1s / faststart）+ 封面图 + 时间线雪碧图 + 音频波形
- **广泛的格式兼容**：VFR 归一 CFR、`bwdif` 去隔行、HDR `zscale+tonemap` 到 BT.709、多音轨取首轨下混立体声、无音轨出无声代理；转码后校验帧数与首帧 PTS，失败自动重试
- **原片归档存储**：`local / WebDAV / FTP` 三种后端——转码产物始终留在本地保证播放性能，原片转码完成后归档远端并释放本地空间，下载 / 重转码时自动回源（WebDAV 零落盘流式代理）
- 项目 / 文件夹层级、版本堆叠、回收站（30 天自动清理）、标签、搜索、批量 ZIP 下载

### 🔍 帧精确批注

- **逐帧播放器**：`requestVideoFrameCallback` 取呈现帧 `mediaTime` 计算帧号；跳帧 seek 落在帧区间中点保证命中；帧率全程有理数存储，时间码支持 NTSC 丢帧
- **画笔批注**：自由笔 / 箭头 / 矩形 / 文字（Konva），坐标按视频显示区域归一化，任意窗口尺寸与全屏下位置一致
- 单帧与区间批注、自定义标签、图片附件（全屏预览）、@提及、两级线程回复、已解决标记、审阅状态
- **导出修改清单**：CSV / PDF（每条附帧截图，前端 canvas 合成画笔）/ CMX3600 EDL（DaVinci Resolve 标记）/ FCP7 XML（Premiere / FCP 标记）

### 🖥 多版本同屏对比

- 主窗锁定最新版本，1 / 2 / 4 屏布局，最多 3 个对比窗
- 按时间码对齐同步播放（跨不同帧率正确），rAF 漂移纠正（偏差 >0.5s 硬 seek，0.04–0.5s 变速拉回）
- 每窗独立：版本切换、秒级偏移（±1 帧精度）、脱离同步、原生全屏、截帧（PNG 下载 / 挂到批注 / 多窗合成）
- 跨版本关联帧；旧版本批注自动转为只读归档，点击按时间码换算跳转到主窗对应帧

### ⚡ 实时协作与通知

- 评论、审阅状态、转码进度经 Socket.IO 实时推送（Worker `pg NOTIFY` → API `LISTEN` → 项目房间）
- 站内消息中心：未读 / 已读分栏、分页、逐条深链跳转到对应批注（含归档版本定位）
- **飞书通知（群卡片 + 私信双通道）**：服务端直连飞书开放平台，无需中转服务。顶层评论 = 群卡片 @ 项目成员 + 逐人私信；线程回复 = 仅私信相关人、立即送达。内置聚合窗口 / 显式 @ 立即发 / 免打扰时段 / 每日上限四道限流；缓冲持久化入库重启不丢，多实例间用原子租约防重复发送

### 🔐 权限与管理后台

- httpOnly Cookie 会话（argon2id），项目四级角色 `viewer < reviewer < editor < manager`，管理员全局可见；所有接口与媒体文件统一走项目权限校验
- 后台：用户管理（建号 / 禁用即踢下线 / 重置密码 / 职位设置）、项目总览、存储监控（剩余 <15% 顶部告警）、转码任务（查看报错 / 重试）、审计日志（按人 / 操作 / 时间筛选）
- **系统设置后台化**：存储 / 通用 / 安全 / 转码 / 飞书通知均可在后台修改，经 `pg NOTIFY` 跨进程失效缓存**热生效、无需重启**；密码类字段不回传前端明文

## 架构

```text
浏览器（React SPA）
   │ REST · Socket.IO · tus 断点上传 · 媒体播放（Range 请求）
   ▼
app 容器：API 进程（Fastify + Socket.IO，同时托管前端页面和媒体文件）
   │                                  ▲
   ▼                                  │ LISTEN/NOTIFY：转码进度、设置变更
postgres 容器（业务数据 · 会话 · pg-boss 任务队列）
   ▲
   │ 取任务 / 回报进度
worker 容器：转码进程（FFmpeg）

app 与 worker 共享宿主机媒体目录 MEDIA_DIR：
  tmp/                     上传中的分块
  originals/{versionId}/   原片（可归档至 WebDAV/FTP 远端）
  renditions/{versionId}/  proxy.mp4 · poster.jpg · sprite.jpg · waveform.json
```

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript 全栈（时间码换算 / zod schema / 角色常量前后端共用一份） |
| 前端 | React 19 · Vite · React Router 7 · TanStack Query · Zustand · antd（暗色）· Konva · Uppy/tus |
| 后端 | Fastify 5 · Prisma · PostgreSQL 17 · pg-boss · Socket.IO · @tus/server · argon2 |
| 转码 | FFmpeg（独立 Worker 进程，纯 CPU） |
| 部署 | Docker Compose 三容器（app 与 worker 共用同一镜像、不同启动命令） |

## 快速开始（Docker）

```bash
cd deploy
cp .env.example .env    # 至少修改 POSTGRES_PASSWORD 和 INITIAL_ADMIN_PASSWORD
docker compose up -d    # app :3000 + worker + postgres；app 启动时自动迁移并创建初始管理员
```

浏览器打开 `http://<服务器IP>:3000`，使用 `.env` 中的初始管理员账号登录（首次登录会要求改密）。

> 内网离线部署：开发机 `docker save` 导出镜像 → 服务器 `docker load` → 同上启动。

## 本地开发

环境要求：Node ≥ 22、pnpm ≥ 11、FFmpeg（转码相关功能）、Docker（或自备 PostgreSQL 实例）。

```bash
pnpm install

# 1. 启动 PostgreSQL
docker run -d --name frametalk-pg -e POSTGRES_USER=frametalk -e POSTGRES_PASSWORD=frametalk \
  -e POSTGRES_DB=frametalk -p 5432:5432 postgres:17

# 2. 数据库迁移
cd apps/server
export DATABASE_URL=postgres://frametalk:frametalk@localhost:5432/frametalk   # Windows PowerShell: $env:DATABASE_URL="..."
export MEDIA_DIR=/path/to/media                                # 媒体存储目录
pnpm prisma-generate && pnpm db:migrate:dev
cd ../..

# 3. 启动服务（三个终端）
pnpm dev:server   # API   http://localhost:3000
pnpm dev:worker   # 转码 Worker
pnpm dev:web      # 前端  http://localhost:5173（/api 已代理到 :3000）
```

导入一条本地视频做演示（同步转码，不走队列）：

```bash
pnpm seed-demo path/to/video.mp4 演示项目
```

> **Prisma 注意事项**
> - 国内网络下载引擎慢时设置 `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma`。
> - `prisma migrate diff` 的 `--shadow-database-url` **绝不可指向真实业务库**：Prisma 会 reset 影子库，指错等于清空真库全部表。请单独建一个影子库（如 `frametalk_shadow`）。

## 测试

```bash
pnpm test          # Vitest 单测：时间码换算（丢帧边界 / 往返）、权限矩阵、转码方案构建、导出器
pnpm test:compat   # 兼容矩阵：生成样片 → 转码 → 校验帧率 / 帧数 / 音轨（需本机 FFmpeg）
pnpm gen:patterns  # 生成帧精度测试片（竖纹二进制编码帧号，肉眼即可核对帧精度）
pnpm test:frame    # 帧精度 e2e（需已部署实例 + FRAME_ASSET_URL 指向导入的测试片）
pnpm test:e2e      # Playwright 全链路验收（需本机 Chrome / Edge）

node scripts/feishu-smoke.mjs   # 飞书通知冒烟：内置开放平台桩服务，无需真实飞书应用
```

## 配置

关键环境变量（完整清单见 [deploy/.env.example](./deploy/.env.example)）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 | — |
| `MEDIA_DIR` | 宿主机媒体目录 | `/data/media` |
| `APP_PORT` | 对外端口 | `3000` |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | 初始管理员（仅首次启动创建） | `admin@local` / `changeme123` |
| `STORAGE_BACKEND` | 原片归档后端：`local` \| `webdav` \| `ftp` | `local` |
| `FEISHU_BASE_URL` | 飞书 API 基址覆盖（测试指向本地桩用） | `https://open.feishu.cn/open-apis` |

运行期配置（存储凭证 / 安全 / 转码 / 飞书通知）统一在管理后台「系统设置」中维护，修改即时热生效。

**接入飞书通知**：在飞书开放平台创建企业自建应用，把 App ID / Secret 填入后台「系统设置 → 飞书通知」，为应用开通 `contact:user.id:readonly`、`im:message`、`im:chat:readonly` 权限，通讯录数据范围覆盖项目成员，并将机器人拉入目标群。网络仅需**出站**访问 open.feishu.cn:443——飞书不回调本服务，无需公网 IP / 域名 / 入站端口映射。

## 目录结构

```text
apps/web          前端：React 19 + Vite + antd（暗色）+ Konva 画笔 + Uppy/tus 上传
apps/server       后端：Fastify 5 API（api.ts）+ 转码 Worker（worker.ts）+ Prisma schema/迁移
packages/shared   前后端共享：时间码换算（含 NTSC 丢帧）、zod schema、角色常量
deploy/           Dockerfile（app/worker 同镜像）、docker-compose、.env.example、backup.sh（restic 每日增量备份）
e2e/              Playwright 端到端测试（验收全链路 + 帧精度用例）
scripts/          帧精度测试片生成、飞书通知冒烟测试与开放平台桩服务
```

## 设计文档

设计与实现文档（功能矩阵、设计取舍、总体架构、技术选型、关键设计详解）见 [PLAN.md](./PLAN.md)。

## 贡献

欢迎提 Issue 和 PR。较大的功能变更请先开 Issue 讨论方向。

## License

[MIT](./LICENSE)
