# 帧言 FrameTalk 设计与实现文档

> 状态：已实现并持续迭代 ｜ 技术栈：TypeScript 全栈（Node.js + React）

帧言 FrameTalk 是可私有化部署的音视频审片协作平台，覆盖完整的核心审片闭环：

**上传素材 → 自动转码 → 在线逐帧批注 → 版本迭代 → 团队审阅 → 导出修改清单**

本文档只记录**已完成**的设计与实现（第 2 节为功能矩阵）；明确不做的取舍见第 3 节。

## 1. 设计前提

| 项 | 决定 | 理由 |
|---|---|---|
| 部署 | Linux 服务器 + Docker Compose 三容器，纯内网 | 私有化自托管，数据不出内网 |
| 账号 | 本地账号，管理员后台建号 / 禁用 / 重置密码 | 不依赖第三方登录 |
| 素材 | 以 MP4 为主，单条一般 ≤ 10 分钟，兼容常见专业格式 | 面向影视 / 广告 / 动画团队短片审片 |
| 量级 | 账号 ≤ 100、同时在线 ≤ 20、每月几百条 | 单机 + PostgreSQL 足够，无需 Redis / 对象存储 / nginx |
| 存储 | 本机 RAID 磁盘 + 每日 restic 增量备份；原片可归档 WebDAV / FTP | 量级下单机足够，转码直接读盘最快 |
| 转码 | 纯 CPU，Worker 并发 1 | 每个工作日约 20 条短片，无需 GPU |
| 传输 | 内网 HTTP | 需要加密时给 Fastify 配内部证书即可，不改架构 |

## 2. 功能矩阵（已完成）

图例：✅ 已实现 ｜ 🔶 部分实现（差异见说明）

### 2.1 素材上传与管理

| 功能 | 状态 | 实现 |
|---|---|---|
| 大文件断点续传、多文件并行上传 | ✅ | tus 协议 50MB 分块（Uppy + @tus/server），拖拽多文件，断网自动续传、刷新后从断点继续 |
| 上传文件夹 | 🔶 | 支持选择与拖拽文件夹，平铺导入（子目录内视频各自成为当前目录资产，不保留层级） |
| 项目资产集中存放、成员共享 | ✅ | 项目 / 文件夹层级，加入项目即共享全部资产 |
| 文件自动分类 | ✅ | `Asset.kind`：视频 / 音频 / 图片 / 其他 |
| 自定义标签 | 🔶 | 项目级自定义批注标签（≤20 个 / 项目，7 色板；单条批注 ≤5 个）；暂无全站标签库 |
| 资产搜索 | 🔶 | 资产名不区分大小写搜索；批注全文搜索（命中线程楼层也算命中） |
| 一键打包批量下载 | ✅ | 批量 ZIP 下载 |
| 云端资产同步本地 NAS 归档 | ✅ | 对等且更彻底：原片归档 `local / WebDAV / FTP`（`STORAGE_BACKEND`），转码产物始终本地保播放性能；下载 / 重转码自动回源，WebDAV 零落盘流式代理 |
| 多版本文件、版本组、历史回溯 | ✅ | 版本堆叠（versionNo 自增）、资产重命名、宫格 / 表格双视图、任意版本回溯浏览 |
| 回收站 | ✅ | 软删 + 30 天自动清理 + 恢复 |
| 媒体元数据查看 | ✅ | ffprobe 全量入库：有理数帧率、帧数、时长、起始时间码、扫描方式、色彩信息 |
| 自定义封面 | ➖ | 封面由转码自动生成（10% 时长处截图） |

### 2.2 云端转码与在线预览

| 功能 | 状态 | 实现 |
|---|---|---|
| 多格式在线预览 | 🔶 | 视频为主：统一转码 1080p H.264 代理播放；无法解码的格式（RAW 等）标记「仅存储」，原片仍可下载 |
| 1080p 高清在线播放 | ✅ | H.264 High + AAC，CRF20、码率上限 12Mbps、GOP≈1s、faststart；Range 请求拖动进度 |
| 音频波形图 | ✅ | 低采样率 PCM 峰值 JSON，时间线绘制 |
| 时间线缩略图 | ✅ | 雪碧图 + 索引 JSON |
| 广泛格式兼容 | ✅ | VFR 归一 CFR、`bwdif` 去隔行、竖屏自动旋转、HDR `zscale+tonemap` 到 BT.709、多音轨取首轨下混立体声、无音轨出无声代理（兼容矩阵见 6.2） |
| 转码质量校验与失败处理 | ✅ | 转码后校验首帧 PTS=0、CFR 源帧数一致；失败自动重试 2 次后标 FAILED，后台可查 FFmpeg 报错并手动重试 |

### 2.3 逐帧批注与在线审片（核心模块）

| 功能 | 状态 | 实现 |
|---|---|---|
| 「圈点画」画面批注：箭头 / 画笔 / 方框 / 文字 | ✅ | react-konva 四种工具 + 颜色 / 线宽，矢量 JSON 按视频显示区域归一化 0~1，任意窗口 / 全屏位置一致 |
| 单帧批注 | ✅ | 锚定具体版本帧号 `frameIn`（不存秒数），跨设备帧级一致 |
| 区段批注 | ✅ | `frameIn / frameOut` 区间 |
| 批注附件 | ✅ | 任意类型 ≤500MB；图片 / 视频 / PDF / 文本内联预览，其余下载；全屏预览弹窗 |
| 批注标签 | ✅ | 项目级自定义标签，批注列表彩色展示、可按标签筛选 |
| @提及 | ✅ | 输入 @ 弹成员下拉；站内通知 + 飞书私信即时送达 |
| 评论回复 | ✅ | 两级线程（楼主 + 平铺楼层，>5 楼收起，展开全文 / 收起），回复自动继承帧区间 |
| 标记已解决 | ✅ | `resolvedAt` + 状态筛选 |
| 审阅状态 | ✅ | 资产级审阅状态，审阅角色及以上可改，实时同步 |
| 修改意见自动汇总 | ✅ | 批注列表按时间码有序汇集，与问题画面一一对应；一键导出修改清单（见 2.6） |
| 多版本意见查看 | ✅ | 旧版本批注只读归档展示，点击按时间码换算跳主窗对应帧；新批注一律建在最新版 |
| 批注筛选 | ✅ | 状态 / 作者 / 标签组合筛选 |
| 逐帧播放、意见精确到帧 | ✅ | `requestVideoFrameCallback` 帧级定位，帧率有理数全程存储，NTSC 丢帧时间码（见 6.3） |
| 多人实时协同审片 | ✅ | Socket.IO 推送评论 / 状态 / 转码进度，对方页面 2 秒内出现，无需刷新 |
| 帧截取 | ✅ | canvas 截取当前帧：PNG 下载 / 挂到批注 / 多窗 2×N 合成截帧 |
| 连续审片体验 | ✅ | 审阅页沉浸式布局 + 同级剧集侧栏（搜索 / 封面 / 审阅状态 / 切集不重挂载） |

### 2.4 版本管理与对比

| 功能 | 状态 | 实现 |
|---|---|---|
| 多版本同屏同步播放 | ✅ | 1 / 2 / 4 屏布局；主窗锁定最新版 + 最多 3 个对比窗，每窗独立切换版本 |
| 同步精度 | ✅ | 按时间码对齐（跨不同帧率正确，如 60fps 对 30fps）；rAF 漂移纠正：偏差 >0.5s 硬 seek、0.04–0.5s 变速 15% 拉回；联调实测同播漂移 ≤30ms |
| 独立控制 | ✅ | 每窗秒级偏移（±1 帧微调）、脱离 / 重对齐同步、独立全屏、A-B 循环 |
| 同时查看过往批注 | ✅ | 归档批注在对比页可查看并跳转（见 2.3） |
| 跨版本帧关联 | ✅ | `FrameLink`：主版本帧与任意对比版本帧建立关联（帧率换算），点击互跳；唯一约束防重复 |
| 分享对比视图 | ✅ | URL `?vs=id1,id2,id3` 直达多屏对比布局 |

### 2.5 分享、通知与协作

| 功能 | 状态 | 实现 |
|---|---|---|
| 资产链接分享（定位到帧） | ✅ | 复制链接带 `?f=帧号` 直接定位，`?c=批注id` 直达批注线程（含归档版本定位与滚动）；打开需登录且有项目权限 |
| 消息机器人（飞书） | ✅ | 服务端直连飞书开放平台（无中转服务）：**群卡片 + 私信双通道**——顶层评论 = 群卡片 @ 项目成员 + 逐人私信；线程回复 = 仅私信相关人（@谁私信谁）、立即送达；卡片含项目名 / 集数 / 紧急色 / 深链按钮，失败自动降级纯文本；两通道独立容错，任一成功不重发 |
| 通知防刷屏限流 | ✅ | 聚合窗口 / 显式 @ 立即发 / 免打扰时段 / 每日上限四道，后台可配；缓冲持久化入库重启不丢；多实例原子租约防双发 |
| 站内消息中心 | ✅ | 未读 / 已读分栏 + 分页 + 全部已读；逐条深链跳转对应批注 |
| 多端实时同步 | ✅ | 评论、审阅状态、转码进度经 Socket.IO 实时推送（Worker `pg NOTIFY` → API `LISTEN` → 项目房间）；响应式网页 |

### 2.6 导出与交付

| 功能 | 状态 | 实现 |
|---|---|---|
| 批注导出意见清单 | ✅ | CSV / PDF（每条批注附帧截图，前端 canvas 合成画笔后回传），时间码与画面一一对应 |
| 剪辑软件标记交付 | ✅ | CMX3600 EDL（DaVinci Resolve 标记）+ FCP7 XML（Premiere / FCP 标记），时间码含源起始 TC 与丢帧——以标准标记文件导出实现闭环，三款主流剪辑软件均可用 |
| 打包下载交付 | ✅ | 批量 ZIP（见 2.1） |

### 2.7 权限体系

| 功能 | 状态 | 实现 |
|---|---|---|
| 项目角色权限 | ✅ | 四级 `viewer < reviewer < editor < manager` + 系统管理员全局可见；所有接口与媒体文件统一 `requireProjectRole` 校验；权限矩阵表驱动单元测试 |
| 账号与会话安全 | ✅ | httpOnly Cookie 会话（存 PG、可即时吊销）+ argon2id 哈希 + 登录连续失败锁定（阈值 / 时长后台可调） |
| 成员管理 | ✅ | 建号（首登强制改密）、禁用即踢下线、重置密码、设管理员；邮箱或手机号登录 |
| 团队角色标识 | ✅ | 人员职位标签（导演 / 制片 / 剪辑 / 生成，可扩展），批注列表与成员处以彩色标签展示 |

### 2.8 管理后台与运维（私有化部署自管能力）

| 功能 | 状态 | 说明 |
|---|---|---|
| 用户 / 项目 / 存储 / 任务 / 审计五大后台页 | ✅ | 项目总览（归档 / 恢复）、存储监控（剩余 <15% 全站告警）、转码任务（查报错 / 重试）、审计日志（按人 / 操作 / 时间筛选） |
| 系统设置后台化 | ✅ | 存储 / 通用 / 安全 / 转码 / 飞书通知分组配置，`pg NOTIFY` 跨进程失效缓存**热生效无需重启**；密码字段不回传前端明文 |
| 每日备份 | ✅ | `backup.sh`：pg_dump + restic 增量，保留 7 日 / 4 周 / 6 月 |
| 自动清理 | ✅ | 回收站 30 天到期清理媒体文件、tmp 未完成上传 24h 清理 |

## 3. 设计取舍（明确不做的功能）

| 功能 | 不做原因 |
|---|---|
| 外链分享体系（免注册链接 / 密码 / 有效期 / 次数限制 / 防转存 / 防翻录浮标 / 烧录水印副本） | 定位纯内网，全员实名账号；防泄露由权限控制 + 审计日志承担 |
| Premiere 插件（审编一体） | 用 EDL / FCP XML 标准标记导出替代（见 2.6） |
| 桌面客户端 / 微信小程序 / 移动 App | 只做响应式网页 |
| 远程监看（RTMP / SRT 推流、多机位、超低延迟） | 属拍摄现场监看场景，不在后期审片闭环内 |
| 4K 代理 / 杜比视界 | 1080p 代理足够审片，看细节下载原片 |
| 文档 / PSD / AI 源文件预览、RAW 预览、色彩管理、多音轨切换 | 可上传可下载，不做在线预览 |
| 「不转码直接播原片」快速通道 | 统一转码换取一致的逐帧精度 |
| 多租户、计费、席位、外部协作角色 | 自托管单租户场景无意义 |
| AI 功能 / MCP Server | 不在审片闭环内 |

## 4. 总体架构

```
浏览器（React）
   │ 接口 · WebSocket · tus 断点上传 · 媒体播放（Range 请求）
   ▼
app 容器：API 进程（Fastify + Socket.IO，同时托管前端页面和媒体文件）
   │                                  ▲
   ▼                                  │ LISTEN/NOTIFY：转码进度、系统设置变更
postgres 容器（业务数据 · 会话 · pg-boss 任务队列）
   ▲
   │ 取任务 / 回报进度
worker 容器：转码进程（FFmpeg）

app 与 worker 共同读写宿主机媒体目录 MEDIA_DIR：
  tmp/（上传中）  originals/{versionId}/原文件（可归档远端）
  renditions/{versionId}/proxy.mp4、poster.jpg、sprite.jpg、waveform.json
```

- **只有三个容器**：app、worker、postgres。不需要 Redis、对象存储和 nginx。
- **上传**：tus 协议直接写入媒体目录，断点续传由协议自带。
- **播放**：API 校验权限后直接返回文件（`@fastify/static`，支持 Range 拖动），内网 20 人同时观看足够。
- **转码与 API 分进程**：FFmpeg 会吃满 CPU，独立容器避免拖慢接口；同一镜像、不同启动命令。
- **进程间事件**：转码进度与设置变更都走 Worker/后台写库 + `NOTIFY`，API `LISTEN` 后经 Socket.IO 推前端或失效缓存。

## 5. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（前后端） | 时间码换算、接口校验 schema 前后端共用一份 |
| 仓库 | pnpm workspace 单仓 | 三个包，见第 8 节 |
| 前端框架 | React 19 + Vite + React Router + TanStack Query + Zustand | 服务端数据交给 Query，播放器状态用 Zustand |
| UI 组件 | Ant Design（暗色主题） | 表格、表单、树、弹窗齐全，中文本地化；审阅页自研 |
| 播放器 | 原生 `<video>` + `requestVideoFrameCallback`，自研控制条与时间线 | 需要逐帧控制和批注叠加，现成播放器反而碍事 |
| 画笔批注 | react-konva | 画笔/箭头/矩形/文字，坐标归一化后存 JSON |
| 上传 | 前端 Uppy + @uppy/tus，后端 @tus/server + @tus/file-store | 断点续传是协议自带能力 |
| 后端框架 | Fastify 5 + zod | 轻量；不选 NestJS，其依赖注入样板对小团队是负担 |
| 数据库 | PostgreSQL 17 + Prisma | 迁移与类型安全 |
| 任务队列 | pg-boss（基于 PostgreSQL） | 每天约 20 个转码任务，PG 足以承担；省掉 Redis |
| 实时 | Socket.IO | 评论、状态、转码进度推送 |
| 转码 | FFmpeg / ffprobe（镜像内 apt 安装） | 行业标准，格式覆盖最广 |
| 登录 | httpOnly Cookie 会话（存 PG）+ argon2 密码哈希 + 登录失败限流 | 同域网页应用，会话比 JWT 简单且可即时吊销；禁用账号立刻生效 |
| 测试 | Vitest + Playwright | Playwright 自带 Chromium 不含 H.264 解码，视频用例须 `channel: 'chrome'` 或 `'msedge'` |

## 6. 关键设计

### 6.1 上传

1. Uppy 以 tus 协议按 50MB 分块上传到 `/api/uploads`，元数据带 projectId、folderId，传新版本时带 assetId。
2. 服务端 `onUploadCreate` 校验登录与项目权限（编辑及以上）与磁盘剩余，文件先写入 `tmp/`。
3. `onUploadFinish`：同盘移动到 `originals/{versionId}/` → 建 `AssetVersion` → 投递转码任务。
4. 续传：tus 客户端按文件指纹在浏览器本地记录上传地址，断网自动续传；刷新后重选同一文件从断点继续。
5. 定时任务清理 24 小时未完成的临时文件。
6. 前端上传为弹窗式 Dashboard（暗色 / 中文），支持文件夹选择与拖拽（平铺导入，`webkitRelativePath` 参与去重）。

### 6.2 转码与格式兼容

所有视频统一转码，Worker 直接读原片，依次生成：

| 产物 | 规格 |
|---|---|
| 元数据 | ffprobe：帧率（**有理数存储**，如 `24000/1001`，禁止浮点）、帧数、时长、分辨率、编码、起始时间码、扫描方式、色彩信息 |
| 1080p 代理 | H.264 High + AAC 立体声；CRF 20，码率上限 12Mbps；低于 1080p 的源保持原分辨率；GOP ≈ 1 秒；`-movflags +faststart` |
| 封面 | 10% 时长处截图 |
| 时间线缩略图 | 每 N 秒取一帧拼成雪碧图 + 索引 JSON |
| 波形 | 解出低采样率 PCM，计算峰值 JSON |

按 ffprobe 结果自动套用的兼容处理：

| 情况 | 处理 |
|---|---|
| 可变帧率（手机录屏等） | 按平均帧率归到最近标准帧率，`-fps_mode cfr -r` 强制恒定帧率 |
| 隔行扫描（如广播 MXF 1080i50） | `bwdif` 去隔行，帧率保持不变 |
| 竖屏 / 带旋转元数据 | FFmpeg 自动旋转，记录显示宽高 |
| HDR（iPhone HLG / 杜比视界 HEVC 10-bit） | `zscale` + `tonemap` 转 SDR BT.709，否则画面发灰 |
| 多声道 / 多音轨 | 取第一条音轨，下混立体声 |
| 无音轨 | 正常输出无声代理 |
| 无法解码（RAW 等） | 标记「不支持预览」，原片仍可下载 |

- 转码后校验：代理首帧时间戳为 0；恒定帧率源代理帧数须与源一致，否则判失败。
- 进度：解析 FFmpeg `-progress` 输出，写库并 `NOTIFY`。
- 失败自动重试 2 次，仍失败标 `FAILED`，界面显示报错末尾几行，管理员可后台手动重试。
- 原片归档：转码完成后按 `STORAGE_BACKEND` 上传 WebDAV / FTP 并删本地副本；下载 / 批量 zip / 重转码自动回源（WebDAV 流式代理零落盘）。归档凭证在后台「系统设置 → 存储」维护。

### 6.3 帧精确播放（本项目最大技术风险，已验证方案）

- `video.currentTime` 不是帧精确的。用 `requestVideoFrameCallback` 取当前呈现帧的 `mediaTime`，`帧号 = round(mediaTime × fpsNum / fpsDen)`。
- 跳到第 N 帧：seek 到该帧显示区间中点 `(N + 0.5) × fpsDen / fpsNum`，避免浮点误差落到相邻帧。
- 时间码 = 源起始时间码 + 帧号；29.97 / 59.94 支持丢帧（drop-frame）。换算工具在 `packages/shared`，单测覆盖各帧率与丢帧边界 / 往返。
- 快捷键：← → 逐帧，J/K/L 倍速，空格播放 / 暂停，I/O 设区间。
- 浏览器自动化验证方法：生成 16 条竖纹按二进制编码帧号的测试片（`pnpm gen:patterns`），播放器当前帧画到 canvas 取竖纹中心像素解出帧号，与界面显示帧号比对：

```bash
ffmpeg -f lavfi -i "color=gray:s=320x180:r=30000/1001:d=60" \
  -vf "geq=lum='if(mod(floor(N/pow(2,floor(X*16/W))),2),235,16)':cb=128:cr=128,scale=1920:1080:flags=neighbor" \
  -c:v prores_ks -profile:v 2 test_2997.mov
```

### 6.4 批注数据

- 批注锚定在**具体版本的帧号**上（`frameIn`，区间批注加 `frameOut`），不存秒数。
- 画笔存矢量 JSON，坐标按**视频画面实际显示区域**（扣除黑边）归一化 0~1，任意窗口尺寸、全屏下位置一致：

```json
{"shapes":[
  {"t":"arrow","pts":[0.12,0.30,0.25,0.42],"color":"#ff3b30","w":0.004},
  {"t":"text","x":0.50,"y":0.20,"text":"这里偏色","size":0.03}
]}
```

- 回复为两级线程：`Comment.parentId` 存直接回复目标，前端归组成「楼主 + 平铺楼层」（孤儿提升 / 环截断 / 楼层号）；回复强制继承父评论帧区间；时间轴只画楼主。
- 附件独立表 `CommentAttachment`，提交批注时以 `attachmentIds` 绑定；未绑定附件仅上传者可见。

### 6.5 多版本同屏对比

- 布局：主窗锁定最新版，1 / 2 / 4 屏（Segmented 切换），最多 3 个对比窗（`SyncVideoPane`）；URL `?vs=` 种子对比窗，旧 `?v=` 单版本兼容。
- 同步引擎 `useVersionSync`：按**时间码**对齐（跨帧率正确），rAF 每帧漂移纠正——偏差 >0.5s 硬 seek，0.04–0.5s 以 15% 变速拉回。
- 每窗独立能力：版本切换、秒级偏移（±1 帧）、脱离 / 重对齐同步、原生全屏、A-B 循环。
- 截帧 `capture.ts`：canvas 截取 rendition 流（单窗 PNG / 挂批注标签 / 2×N 多窗合成）。
- 关联帧：`FrameLink` 表，唯一约束 base+target 帧对；主版本必须是最新版，否则 400。
- 归档守卫：旧版本 POST 批注 → 400；历史批注只读展示，点击按时间码换算跳主窗帧（联调验证：30fps 版帧 30 → 60fps 主窗帧 60）。

### 6.6 实时与飞书通知

- 实时链路：Worker / 后台写库 + `pg NOTIFY` → API `LISTEN` → Socket.IO 按项目房间推送（评论、审阅状态、转码进度）。
- 飞书通知（`apps/server/src/notify/feishu.ts`）为**服务端直连飞书开放平台**的内置客户端（原生 fetch，无中转服务、无额外进程）：
  - tenant_access_token 管理：缓存、提前 60s 刷新、按 appId 失效、in-flight 去重。
  - 身份解析：手机号 / 邮箱 → open_id（`contact/v3/users/batch_get_id`，每批 ≤50；手机号优先、邮箱降级）。
  - 投递：`im/v1/messages`，interactive 卡片优先、被拒降级纯文本；**双通道**——顶层评论 = 群卡片（markdown `<at>` @ 全体成员−作者）+ 逐人私信（间隔 250ms 防频控）；线程回复 = 仅私信线程参与者与被 @ 者，绕过聚合窗口立即送达（仍限 30s 最小间隔）。两通道独立容错：任一成功即勾掉本批，避免重试重复发送。
  - 四道限流（后台「系统设置 → 飞书通知」）：聚合窗口 windowMinutes、显式 @ 立即发（mentionBypass）、免打扰时段（跨午夜）、每日上限 dailyMax / 项目。
  - 可靠性：缓冲持久化 `FeishuNotifyBuffer` 表（重启不丢），30s sweeper + 进程内定时器双驱动；多进程竞争用**原子 claim 租约**（`UPDATE…WHERE dueAt<=now`）防双发；连续失败 5 次放弃该批。
  - 网络要求：仅需**出站**访问 open.feishu.cn:443（飞书不回调本服务，无需公网 IP / 域名 / 入站端口）；基址 `FEISHU_BASE_URL` 可覆盖，测试指向本地桩（`scripts/feishu-stub.mjs`）。

### 6.7 分享与权限

- 分享 = 复制资产页链接，可带 `?f=帧号` / `?c=批注id` 直接定位；打开需登录且是项目成员。纯 HTTP 下剪贴板接口不可用，「复制链接」按钮带降级实现。
- 系统角色：管理员 / 成员。项目角色四级：manager（管理成员、删除）> editor（上传、整理）> reviewer（查看、评论、改审阅状态）> viewer（只读）。
- 所有接口统一 `requireProjectRole(用户, 项目, 最低角色)`，媒体文件接口同样走这一检查；权限矩阵表驱动单测。
- 登录：邮箱或 11 位手机号（`account` 字段），argon2id 哈希，连续失败锁定，禁用账号立即踢下线。

### 6.8 管理后台与系统设置

| 页面 | 功能 |
|---|---|
| 用户管理 | 建号并设初始密码（首登强制改密）、禁用 / 启用（立即踢下线）、重置密码、设管理员、职位设置 |
| 项目总览 | 全部项目、负责人、成员数、占用空间、最近活动；归档 / 恢复 |
| 存储监控 | 磁盘总量 / 已用 / 剩余、各项目占用；剩余低于 15% 全站顶部告警 |
| 转码任务 | 排队 / 进行中 / 失败列表，查看报错、手动重试 |
| 审计日志 | 登录、下载、删除、权限变更、账号变更；按人 / 时间 / 操作类型筛选 |
| 系统设置 | 存储 / 通用 / 安全 / 转码 / 飞书通知分组配置，热生效（`SettingGroup` 表 + 缓存 + `pg NOTIFY` 跨进程失效）；密码字段以占位符脱敏、不回明文 |

初始管理员在首次启动时按 `.env` 中的账号创建。后台通用表格统一使用自研 `DataTable`（暗色、sticky 表头、服务端 / 本地双分页模式）。

### 6.9 数据模型（Prisma 主要表）

| 表 | 关键字段 |
|---|---|
| User | name, email（可空）, phone（唯一，可空）, passwordHash, isAdmin, title（职位）, mustChangePassword, disabledAt |
| Session | userId, expiresAt |
| Project / ProjectMember | name, customLabels(JSON), archivedAt / role |
| Folder | projectId, parentId?, name, deletedAt |
| Asset | projectId, folderId?, name, kind, reviewStatus, deletedAt |
| AssetVersion | assetId, versionNo, filePath, size, status, progress, fpsNum, fpsDen, frameCount, startTimecode, probe(JSON), uploadedBy |
| Rendition | versionId, kind（代理/封面/雪碧图/波形）, filePath, meta(JSON) |
| Comment | versionId, parentId?, authorId, frameIn, frameOut?, body, drawing(JSON), labels, resolvedAt |
| CommentAttachment | 批注附件（任意类型 ≤500MB，绑定后项目成员可见） |
| FrameLink | 跨版本关联帧（base+target 帧对唯一） |
| Notification | userId, type, payload(JSON，含 projectId 深链), readAt |
| SettingGroup | 系统设置分组（JSON，热生效） |
| FeishuNotifyBuffer | 飞书通知缓冲（projectId 主键，pending JSON，dueAt 租约） |
| AuditLog | actorId, action, target, ip, createdAt |

pg-boss 自带任务表，无需自建。

## 7. 部署与运维

### 服务器配置建议

| 部件 | 配置 | 说明 |
|---|---|---|
| CPU / 内存 | 8 核以上 / 32GB | 每个工作日约 20 条短片，纯 CPU 转码足够 |
| 系统盘 | NVMe SSD 1TB | 系统、Docker、数据库 |
| 媒体盘 | RAID 5（如 4 × 8TB），挂载到 `MEDIA_DIR` | 10 分钟 1080p 原片+代理约 2~5GB/条；每月 500 条约增长 1~2.5TB |
| 备份 | NAS 或备份盘 ≥ 媒体盘已用量 | restic 增量 |
| 系统 | Ubuntu 24.04 LTS + Docker Engine | — |

### 部署文件

```
deploy/
  Dockerfile           node:24-slim + apt 安装 ffmpeg；app 与 worker 共用镜像
  docker-compose.yml   app、worker、postgres 三服务；媒体目录挂到 app 与 worker
  .env.example         数据库密码、初始管理员、端口、存储后端
  backup.sh            每日 pg_dump + restic 增量备份（7 日 / 4 周 / 6 月）
```

- **启动**：`docker compose up -d`；app 启动自动 `prisma migrate deploy` 并创建初始管理员。
- **升级**：替换镜像后 `docker compose up -d`。
- **离线部署**：服务器不能上外网时，开发机（可配镜像加速）构建 / 拉取后 `docker save` 导出，服务器 `docker load` 导入。
- **镜像内 FFmpeg 要求**：版本 ≥ 5.1，含 `zscale`、`tonemap`、`bwdif` 滤镜。
- **备份**：宿主机 cron 每天 02:00 执行 `backup.sh`。

## 8. 代码组织

```
apps/web          React 前端（含 /admin 管理后台），审阅页 / 多版本对比页自研
apps/server       src/api.ts（API 进程）与 src/worker.ts（转码进程），按业务分目录：
                  auth / users / projects / assets / media / review / notify / admin / storage
packages/shared   时间码换算（含 NTSC 丢帧）、zod 接口 schema、角色常量、线程归组（前后端共用）
deploy/           见第 7 节
e2e/              Playwright 端到端（验收全链路 + 帧精度）
scripts/          帧精度测试片生成、飞书通知冒烟与开放平台桩
```

## 9. 测试与验证

```bash
pnpm test          # Vitest：时间码换算（丢帧边界 / 往返）、权限矩阵、转码方案构建、导出器
pnpm test:compat   # 兼容矩阵：生成样片 → 转码 → 校验帧率 / 帧数 / 音轨（需本机 FFmpeg）
pnpm gen:patterns  # 生成帧精度测试片（竖纹二进制编码帧号，见 6.3）
pnpm test:frame    # 帧精度 e2e（需已部署实例 + FRAME_ASSET_URL）
pnpm test:e2e      # Playwright 验收全链路（需系统 Chrome / Edge 通道）
node scripts/feishu-smoke.mjs   # 飞书通知冒烟（内置开放平台桩，无需真实飞书应用）
```

兼容矩阵样片建议覆盖：MP4 H.264/H.265 8/10-bit、iPhone HEVC HDR 竖屏 MOV、手机录屏（VFR）、MOV ProRes 422/4444、MXF（XDCAM 1080i50 / DNxHD）、MKV、WebM（VP9/AV1）、AVI、WMV、FLV、无音轨 / 5.1 声道 / 多音轨。

## 10. 迭代记录

| 时间 | 交付 |
|---|---|
| M1 | 审阅闭环：上传 / 转码 / 逐帧批注 / 实时协作 / 四级权限 / 用户后台 |
| M2 | 协作增强：区间批注、批注标签、附件、@提及、站内通知、回收站、批量 zip、EDL / FCP XML / PDF / CSV 导出 |
| M3 | 管理完善：项目总览、存储监控、转码任务、审计日志、每日备份 |
| 2026-10-24 | 多版本同屏批注页（4 屏 / 时间码同步 / 关联帧 / 截帧）；原片归档存储（WebDAV / FTP）；系统设置后台化（热生效）；资产 CRUD 与宫格 / 表格双视图；手机号登录 |
| 2026-10-25 | 飞书通知双通道（直连免中转）；两级线程回复；消息中心深链 + 未读 / 已读分页；审阅页沉浸化 + 剧集侧栏；文件夹上传；批注附件大文件修复 |
