import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { env, mediaDir } from './env.js';
import { prisma } from './db.js';
import { attachUser } from './auth/guards.js';
import { authRoutes } from './auth/routes.js';
import { userRoutes } from './users/routes.js';
import { projectRoutes } from './projects/routes.js';
import { assetRoutes } from './assets/routes.js';
import { registerUpload } from './assets/upload.js';
import { zipRoutes } from './assets/zip.js';
import { mediaRoutes } from './media/routes.js';
import { reviewRoutes } from './review/routes.js';
import { frameLinkRoutes } from './review/frame-links.js';
import { attachmentRoutes } from './review/attachments.js';
import { notifyRoutes } from './notify/routes.js';
import { adminRoutes } from './admin/routes.js';
import { settingsRoutes } from './admin/settings-routes.js';
import { exportRoutes } from './export/routes.js';
import { initRealtime } from './notify/events.js';
import { startFeishuSweeper } from './notify/feishu.js';
import { clearSettingCache, SETTINGS_NOTIFY } from './admin/settings-service.js';
import { Client } from 'pg';
import { getBoss } from './jobs.js';
import { hashPassword } from './auth/password.js';
import { ensureDir } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  // prisma migrate deploy（独立子进程，避免引入 CLI 依赖差异）
  const schema = path.resolve(__dirname, '../prisma/schema.prisma');
  execFileSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${schema}`], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32', // Windows 下 spawnSync npx 必须走 shell
  });
}

async function ensureInitialAdmin() {
  const count = await prisma.user.count();
  if (count > 0) return;
  await prisma.user.create({
    data: {
      name: env.INITIAL_ADMIN_NAME,
      email: env.INITIAL_ADMIN_EMAIL,
      passwordHash: await hashPassword(env.INITIAL_ADMIN_PASSWORD),
      isAdmin: true,
      mustChangePassword: true,
    },
  });
  console.log(`[api] 已创建初始管理员 ${env.INITIAL_ADMIN_EMAIL}`);
}

async function main() {
  await ensureDir(path.join(mediaDir(), 'tmp'));
  await ensureDir(path.join(mediaDir(), 'originals'));
  await ensureDir(path.join(mediaDir(), 'renditions'));

  if (env.MIGRATE_ON_BOOT !== '0') await migrate();
  await ensureInitialAdmin();

  const app = Fastify({ logger: { level: env.LOG_LEVEL } });
  await app.register(cookie);
  // multipart/form-data：批注附件上传手工解析 raw body（见 review/attachments.ts）
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addHook('preHandler', attachUser);

  // 全局错误格式
  app.setErrorHandler((err: any, _req, reply) => {
    // zod 参数校验失败是客户端错误：400 + 可读消息（不泄露原始 issue JSON）
    if (err?.name === 'ZodError' && Array.isArray(err.issues)) {
      const msg = err.issues.map((i: any) => `${i.path.join('.') || '参数'}：${i.message}`).join('；');
      return reply.status(400).send({ message: msg || '参数错误' });
    }
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ message: err.message ?? '服务器错误' });
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(projectRoutes);
  await app.register(assetRoutes);
  await app.register(zipRoutes);
  await app.register(mediaRoutes);
  await app.register(reviewRoutes);
  await app.register(frameLinkRoutes);
  await app.register(attachmentRoutes);
  await app.register(notifyRoutes);
  await app.register(adminRoutes);
  await app.register(settingsRoutes);
  await app.register(exportRoutes);
  registerUpload(app);

  initRealtime(app);
  startFeishuSweeper(); // 飞书评论摘要：30s 扫描到期缓冲（重启恢复定时器 + 兜底触发）

  // 后台设置变更即时生效：LISTEN pg 通知并清缓存（与 worker.ts 对齐；覆盖 DB 直改/多实例场景）
  const settingsListener = new Client({ connectionString: env.DATABASE_URL });
  settingsListener.on('notification', (msg) => {
    if (msg.payload) clearSettingCache(msg.payload as any);
    app.log.info(`设置已更新: ${msg.payload ?? '(全部)'}，即时生效`);
  });
  await settingsListener.connect();
  await settingsListener.query(`LISTEN ${SETTINGS_NOTIFY}`);

  // 托管前端构建产物：/assets/* 走真实文件（etag/缓存），其余前端路由回 index.html
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    const assetsDir = path.join(webDist, 'assets');
    if (fs.existsSync(assetsDir)) {
      await app.register(fastifyStatic, {
        root: assetsDir, prefix: '/assets/', decorateReply: false, maxAge: '7d',
      });
    }
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.raw.url?.startsWith('/api/') || req.raw.url?.startsWith('/socket.io')) {
        return reply.status(404).send({ message: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`[api] http://${env.HOST}:${env.PORT}  media=${mediaDir()}`);

  // API 进程也初始化 pg-boss（建表/队列）；定时任务由 Worker 注册
  await getBoss().catch((err) => app.log.warn(`pg-boss init(将仅由 worker 提供): ${String(err)}`));
}

main().catch((err) => {
  console.error('[api] fatal:', err);
  process.exit(1);
});
