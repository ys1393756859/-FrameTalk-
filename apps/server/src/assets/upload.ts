import type { FastifyInstance } from 'fastify';
import { Server as TusServer, type Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { prisma } from '../db.js';
import { mediaDir } from '../env.js';
import { requireProjectRole } from '../auth/guards.js';
import { userFromToken } from '../auth/session.js';
import { ensureDir, diskFree, sanitizeFilename, statSafe } from '../util.js';
import { enqueueTranscode } from '../jobs.js';
import { emitEvent } from '../notify/events.js';
import type { AssetKind, SessionUser } from '@frametalk/shared';
import { getSetting } from '../admin/settings-service.js';

function kindFromMime(mime: string, filename: string): AssetKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'mxf', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'r3d', 'braw', 'mvi'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['wav', 'mp3', 'aac', 'flac', 'aiff', 'm4a', 'wma'].includes(ext)) return 'audio';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'psd', 'exr', 'dpx'].includes(ext)) return 'image';
  return 'other';
}

/** 校验 folderId：必须是本项目未删除的文件夹，否则返回 null（落根目录） */
async function validFolderId(folderId: string | null | undefined, projectId: string): Promise<string | null> {
  if (!folderId) return null;
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, projectId, deletedAt: null },
  });
  return folder ? folderId : null;
}

/** 上传完成后：建 AssetVersion 并投递转码 */
async function finalizeUpload(meta: {
  projectId: string; folderId?: string | null; assetId?: string | null;
  filename: string; filetype: string; size: number; tmpPath: string; userId: string;
}) {
  const versionId = crypto.randomUUID();
  const safe = sanitizeFilename(meta.filename);
  const destDir = path.join(mediaDir(), 'originals', versionId);
  await ensureDir(destDir);
  await fsp.rename(meta.tmpPath, path.join(destDir, safe));

  let assetId = meta.assetId ?? null;
  if (assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== meta.projectId || asset.deletedAt) assetId = null;
  }
  if (!assetId) {
    const name = safe.replace(/\.[^.]+$/, '');
    const asset = await prisma.asset.create({
      data: {
        projectId: meta.projectId,
        // 文件夹可能已被删除/换项目：失效则落到根目录，避免外键失败
        folderId: await validFolderId(meta.folderId, meta.projectId),
        name,
        kind: kindFromMime(meta.filetype, safe),
      },
    });
    assetId = asset.id;
  }
  const maxNo = await prisma.assetVersion.aggregate({
    where: { assetId }, _max: { versionNo: true },
  });
  const version = await prisma.assetVersion.create({
    data: {
      id: versionId,
      assetId,
      versionNo: (maxNo._max.versionNo ?? 0) + 1,
      originalName: safe,
      filePath: path.join('originals', versionId, safe).split(path.sep).join('/'),
      size: BigInt(meta.size),
      mime: meta.filetype || 'application/octet-stream',
      status: 'queued',
      uploadedBy: meta.userId,
    },
  });
  await enqueueTranscode(versionId);
  emitEvent({ type: 'asset:update', projectId: meta.projectId, assetId, versionId, status: 'queued' });
  return { assetId, versionId };
}

/** 在途上传字节账本：create 登记、finish/清理释放；防并发上传叠加打爆磁盘 */
class PendingUploads {
  private map = new Map<string, number>();
  add(id: string, size: number) { this.map.set(id, size); }
  release(id: string) { this.map.delete(id); }
  getTotal(): number {
    let sum = 0;
    for (const v of this.map.values()) sum += v;
    return sum;
  }
}
const pendingUploads = new PendingUploads();
/** 已收尾的 upload.id -> 落库结果（幂等：重复 finish 不再建版本） */
const finalized = new Map<string, { assetId: string; versionId: string }>();

export function registerUpload(app: FastifyInstance) {
  const tmpDir = path.join(mediaDir(), 'tmp');
  const tus = new TusServer({
    path: '/api/uploads',
    datastore: new FileStore({ directory: tmpDir }),
    // 单文件上限：读取后台"系统设置-站点"的 maxUploadGb（运行时每次请求都取，改配置即时生效）
    maxSize: async () => {
      const general = await getSetting<any>('general');
      const gb = general.maxUploadGb ?? 200;
      return gb > 0 ? gb * 1024 ** 3 : Number.MAX_SAFE_INTEGER;
    },
    // 授权 Cookie 透传给 CORS 预检（同源部署其实用不到，保留以防反向代理分域）
    allowedCredentials: true,
    // 登录态校验（tus 的 POST/PATCH 都会经过）
    async onIncomingRequest(req: any) {
      // @tus/server v2 基于 srvx：headers 可能是 Fetch 风格 Headers 实例或原生对象
      const headers = req?.headers;
      const cookieRaw = typeof headers?.get === 'function'
        ? headers.get('cookie')
        : headers?.cookie as string | undefined;
      const user = await userFromToken(parseCookie(cookieRaw ?? undefined));
      if (!user) throw { status_code: 401, body: '未登录' };
      (req as any).user = user;
    },
    async onUploadCreate(req: any, upload: Upload) {
      const user: SessionUser = req.user;
      const meta = upload.metadata as Record<string, string | undefined>;
      const projectId = meta.projectId;
      if (!projectId) throw { status_code: 400, body: 'missing projectId' };
      try {
        await requireProjectRole(user, projectId, 'editor');
      } catch {
        throw { status_code: 403, body: '没有上传权限' };
      }
      if (meta.assetId) {
        const asset = await prisma.asset.findUnique({ where: { id: meta.assetId } });
        // 目标资产不存在/已删/不属于该项目：自动降级为"新资产"上传，而不是拒绝
        // （用户常见场景：对着回收站里的资产点了"传新版本"，或资产刚被他人删除）
        if (!asset || asset.projectId !== projectId || asset.deletedAt) {
          delete meta.assetId;
          upload.metadata = meta as Record<string, string | null>;
        }
      }
      if (meta.folderId) {
        // 文件夹已删/换项目：剥掉，资产落根目录（否则落库外键失败）
        const folder = await prisma.folder.findFirst({
          where: { id: meta.folderId, projectId, deletedAt: null },
        });
        if (!folder) {
          delete meta.folderId;
          upload.metadata = meta as Record<string, string | null>;
        }
      }
      // 上传大小上限 + 磁盘剩余检查（含在途并发预留，阈值后台可配）
      const general = await getSetting<any>('general');
      const maxBytes = (general.maxUploadGb ?? 200) * 1024 ** 3;
      if (maxBytes > 0 && (upload.size ?? 0) > maxBytes) {
        throw { status_code: 413, body: `单文件超过上限 ${general.maxUploadGb} GB` };
      }
      // 在途字节账本：所有已创建未完成的上传加总，防止并发上传叠加超磁盘
      const inflight = pendingUploads.getTotal();
      const disk = await diskFree(mediaDir());
      const warnRatio = (general.diskWarnPercent ?? 15) / 100;
      const needed = (upload.size ?? 0) + inflight;
      if (disk && (disk.free < Math.min(disk.total * warnRatio, 20 * 1024 ** 3) || disk.free < needed * 1.1)) {
        throw { status_code: 507, body: '服务器存储空间不足（含进行中的上传预留）' };
      }
      pendingUploads.add(upload.id, upload.size ?? 0);
      return { metadata: { ...meta, userId: user.id } };
    },
    // 幂等收尾：tus 客户端重试可能对同一 upload.id 重复触发 finish（或 finish 后又 PATCH），
    // 以 upload.id 建立内存锁，保证只落库一次
    async onUploadFinish(_req: any, upload: Upload) {
      if (finalized.has(upload.id)) {
        const hit = finalized.get(upload.id)!;
        return { headers: { 'x-asset-id': hit.assetId, 'x-version-id': hit.versionId } };
      }
      const meta = upload.metadata as Record<string, string | undefined>;
      try {
        const size = upload.size ?? (await statSafe(path.join(tmpDir, upload.id)))?.size ?? 0;
        const { assetId, versionId } = await finalizeUpload({
          projectId: meta.projectId!,
          folderId: meta.folderId || null,
          assetId: meta.assetId || null,
          filename: meta.filename ?? 'unnamed',
          filetype: meta.filetype ?? '',
          size,
          tmpPath: path.join(tmpDir, upload.id),
          userId: meta.userId ?? (() => { throw new Error('missing userId'); })(),
        });
        finalized.set(upload.id, { assetId, versionId });
        pendingUploads.release(upload.id);
        if (finalized.size > 1000) {
          // 简单防泄漏：保留最近 1000 条
          const first = finalized.keys().next().value;
          if (first) finalized.delete(first);
        }
        return { headers: { 'x-asset-id': assetId, 'x-version-id': versionId } };
      } catch (err) {
        throw { status_code: 500, body: `落库失败: ${String(err)}` };
      }
    },
  });

  const handler = (req: any, reply: any) => {
    reply.hijack();
    tus.handle(req.raw, reply.raw);
  };
  // tus 的 PATCH body 是原始字节流，禁止 fastify 解析/缓冲（透传给 tus 读 raw）
  app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null, null));
  for (const method of ['POST', 'PATCH', 'HEAD', 'OPTIONS'] as const) {
    app.route({ method, url: '/api/uploads', handler });
    app.route({ method, url: '/api/uploads/*', handler });
  }
}

function parseCookie(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  const entry = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith('sid='));
  return entry ? decodeURIComponent(entry.slice(4)) : undefined;
}
