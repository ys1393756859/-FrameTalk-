import path from 'node:path';
import fsp from 'node:fs/promises';
import { prisma } from './db.js';
import { env, mediaDir } from './env.js';
import { getBoss, enqueueTranscode, QUEUE_TRANSCODE, QUEUE_MAINTENANCE, registerSchedules } from './jobs.js';
import { transcodeVersion } from './media/run.js';
import { publishEvent } from './notify/events.js';
import { statSafe } from './util.js';
import { archiveOriginalIfNeeded, ensureLocal } from './storage.js';
import { timecodeToFrames, type Fps } from '@frametalk/shared';
import { getSetting, clearSettingCache, SETTINGS_NOTIFY } from './admin/settings-service.js';
import { Client } from 'pg';

/** 转码失败自动重试次数（后台"系统设置-转码"可调） */
async function maxAttempts(): Promise<number> {
  const t = await getSetting<any>('transcode');
  return (t.retryLimit ?? 2) + 1;
}

async function setProgress(versionId: string, pct: number, status: string, projectId: string) {
  await prisma.assetVersion.update({
    where: { id: versionId },
    data: { progress: Math.min(100, Math.round(pct)), status },
  });
  await publishEvent({ type: 'version:progress', versionId, projectId, progress: Math.min(100, Math.round(pct)), status });
}

async function handleTranscode(versionId: string) {
  const version = await prisma.assetVersion.findUnique({
    where: { id: versionId }, include: { asset: true, renditions: true },
  });
  if (!version || version.status === 'ready') return;
  const projectId = version.asset.projectId;

  await prisma.assetVersion.update({
    where: { id: versionId },
    data: { status: 'transcoding', progress: 1, error: null },
  });
  await publishEvent({ type: 'version:status', versionId, projectId, status: 'transcoding' });

  // 旧产物清空（重试场景）
  const outDir = path.join(mediaDir(), 'renditions', versionId);
  await fsp.rm(outDir, { recursive: true, force: true });
  await prisma.rendition.deleteMany({ where: { versionId } });

  const originalAbs = path.join(mediaDir(), version.filePath);
  if (!(await statSafe(originalAbs))) {
    // 原片可能已归档到远端（webdav/ftp）：回源后再转码
    try {
      await ensureLocal(version.filePath);
    } catch {
      throw new Error('原片文件不存在');
    }
  }

  let lastDbWrite = 0;
  const artifacts = await transcodeVersion(versionId, originalAbs, (pct, stage) => {
    const now = Date.now();
    if (now - lastDbWrite > 1000 || pct >= 100) {
      lastDbWrite = now;
      setProgress(versionId, pct, 'transcoding', projectId).catch(() => {});
    }
  });

  // 时间码起点：源时间码换算为帧数（供批注显示源 TC）
  let startFrames = 0;
  if (artifacts.info.startTimecode && artifacts.info.fps) {
    try {
      startFrames = timecodeToFrames(artifacts.info.startTimecode, artifacts.info.fps as Fps);
    } catch { startFrames = 0; }
  }
  const tc = artifacts.info.startTimecode && artifacts.info.fps
    ? artifacts.info.startTimecode : null;

  const newStatus = artifacts.proxyRel ? 'ready' : 'unsupported';
  await prisma.assetVersion.update({
    where: { id: versionId },
    data: {
      status: newStatus,
      progress: 100,
      error: null,
      fpsNum: artifacts.info.fps?.num ?? null,
      fpsDen: artifacts.info.fps?.den ?? null,
      frameCount: artifacts.proxyFrames ?? artifacts.info.frameCount ?? null,
      durationSec: artifacts.info.durationSec,
      startTimecode: tc,
      startFrames,
      width: artifacts.info.displayWidth,
      height: artifacts.info.displayHeight,
      probe: artifacts.info.probe as any,
    },
  });
  await prisma.asset.update({ where: { id: version.assetId }, data: { updatedAt: new Date() } });
  await publishEvent({ type: 'version:status', versionId, projectId, status: newStatus, progress: 100 });

  // 原片归档到远端存储（webdav/ftp；local 后端空操作），释放本地空间
  if (newStatus === 'ready') {
    await archiveOriginalIfNeeded(originalAbs, version.filePath);
  }
}

async function workTranscode() {
  const boss = await getBoss();
  await boss.work(QUEUE_TRANSCODE, async (jobs: any[]) => {
    for (const job of jobs) {
      const versionId = job.data.versionId as string;
      try {
        await handleTranscode(versionId);
      } catch (err) {
      const message = String((err as Error).message ?? err);
      const version = await prisma.assetVersion.findUnique({ where: { id: versionId }, include: { asset: true } });
      const attempts = (version?.transcodeAttempts ?? 0) + 1;
      if (attempts < (await maxAttempts())) {
          await prisma.assetVersion.update({
            where: { id: versionId },
            data: { transcodeAttempts: attempts, status: 'queued', progress: 0 },
          });
          enqueueTranscode(versionId, 10).catch(() => {});
          console.warn(`[worker] 转码失败(第${attempts}次) ${versionId}: ${message.split('\n')[0]}`);
        } else {
          await prisma.assetVersion.update({
            where: { id: versionId },
            data: { transcodeAttempts: attempts, status: 'failed', error: message.slice(0, 8000) },
          });
          if (version) {
            await publishEvent({ type: 'version:status', versionId, projectId: version.asset.projectId, status: 'failed', error: message.slice(0, 500) });
          }
          console.error(`[worker] 转码最终失败 ${versionId}: ${message}`);
        }
        // 已落库记录错误，任务本身不再抛出避免 pg-boss 重试（重试由我们自己控制）
      }
    }
  });
}

/** 每小时：清理 24h 未完成的 tmp；每天：清理回收站中删除超 30 天的资产文件 */
async function workMaintenance() {
  const boss = await getBoss();
  await boss.work(QUEUE_MAINTENANCE, async (jobs: any[]) => {
    for (const job of jobs) {
      const kind = job.data?.kind;
      if (kind === 'hourly') {
        const general = await getSetting<any>('general');
        const tmpDir = path.join(mediaDir(), 'tmp');
        try {
          const entries = await fsp.readdir(tmpDir).catch(() => [] as string[]);
          const cutoff = Date.now() - (general.tmpRetentionHours ?? 24) * 3600 * 1000;
          for (const name of entries) {
            const p = path.join(tmpDir, name);
            const st = await statSafe(p);
            if (st && st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
          }
        } catch (err) { console.warn(`[worker] tmp 清理失败: ${String(err)}`); }
      }
      if (kind === 'daily') {
        const general = await getSetting<any>('general');
        const cutoff = new Date(Date.now() - (general.trashRetentionDays ?? 30) * 24 * 3600 * 1000);
        const assets = await prisma.asset.findMany({
          where: { deletedAt: { lt: cutoff } },
          include: { versions: true },
        });
        for (const asset of assets) {
          for (const v of asset.versions) {
            await fsp.rm(path.join(mediaDir(), 'originals', v.id), { recursive: true, force: true }).catch(() => {});
            await fsp.rm(path.join(mediaDir(), 'renditions', v.id), { recursive: true, force: true }).catch(() => {});
          }
          await prisma.asset.delete({ where: { id: asset.id } });
          console.log(`[worker] 回收站过期清理 asset=${asset.id}`);
        }
      }
    }
  });
}

async function main() {
  console.log(`[${env.WORKER_ID}] 启动，等待转码任务...`);
  await registerSchedules();
  await workTranscode();
  await workMaintenance();

  // 后台设置变更即时生效：LISTEN 通知并清缓存
  const listener = new Client({ connectionString: env.DATABASE_URL });
  listener.on('notification', (msg) => {
    if (msg.payload) clearSettingCache(msg.payload as any);
    console.log(`[worker] 设置已更新: ${msg.payload ?? '(全部)'}，即时生效`);
  });
  await listener.connect();
  await listener.query(`LISTEN ${SETTINGS_NOTIFY}`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
