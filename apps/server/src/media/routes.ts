import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { prisma } from '../db.js';
import { mediaDir } from '../env.js';
import { requireAuth, requireMember, httpError } from '../auth/guards.js';
import { audit } from '../audit.js';
import { backend, localExists, storage } from '../storage.js';
import { run } from '../util.js';

const KINDS = new Set(['proxy', 'poster', 'sprite', 'waveform', 'original']);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 同一缓存文件的在途去重：信息面板网格可能并发请求同一帧，只跑一次 ffmpeg
const frameInflight = new Map<string, Promise<void>>();

/**
 * 从 proxy 抽单帧并磁盘缓存到 renditions/<vid>/frames/。
 * w 为 null 时抽全分辨率（q2，大图弹窗）；带 w 时缩到该宽度（q6，网格小图）。
 * 返回相对 mediaDir 的 posix 路径，供 reply.sendFile 使用。
 */
async function extractFrame(proxyRel: string, versionId: string, t: number, w: number | null): Promise<string> {
  const name = w ? `t${t.toFixed(2)}_w${w}.jpg` : `t${t.toFixed(2)}.jpg`;
  const cacheAbs = path.join(mediaDir(), 'renditions', versionId, 'frames', name);
  const cacheRel = path.posix.join('renditions', versionId, 'frames', name);
  if (fs.existsSync(cacheAbs)) return cacheRel;
  const key = `${versionId}:${name}`;
  let p = frameInflight.get(key);
  if (!p) {
    p = (async () => {
      await fsp.mkdir(path.dirname(cacheAbs), { recursive: true });
      const tmp = `${cacheAbs}.part.jpg`; // ffmpeg 按扩展名推断输出格式，临时文件必须带 .jpg
      const scaleArgs = w ? ['-vf', `scale=${w}:-2`, '-q:v', '6'] : ['-q:v', '2'];
      const res = await run(FFMPEG, [
        '-v', 'error', '-ss', t.toFixed(3), '-i', path.join(mediaDir(), proxyRel),
        '-frames:v', '1', ...scaleArgs, '-y', tmp,
      ]);
      if (res.code !== 0 || !fs.existsSync(tmp)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw httpError(500, `抽帧失败: ${res.stderr.split('\n').slice(-3).join(' ')}`);
      }
      await fsp.rename(tmp, cacheAbs);
    })();
    frameInflight.set(key, p);
    p.catch(() => {}).finally(() => frameInflight.delete(key));
  }
  await p;
  return cacheRel;
}

const batchInflight = new Map<string, Promise<number>>();

export async function mediaRoutes(app: FastifyInstance) {
  // 媒体文件一律走权限校验（项目成员即可读），@fastify/static 的 sendFile 支持 Range
  app.get('/api/media/:versionId/:kind', async (req, reply) => {
    const user = await requireAuth(req);
    const { versionId, kind } = req.params as { versionId: string; kind: string };
    if (!KINDS.has(kind)) throw httpError(404, 'not found');
    const version = await prisma.assetVersion.findUnique({
      where: { id: versionId },
      include: { asset: true, renditions: true },
    });
    if (!version) throw httpError(404, '版本不存在');
    await requireMember(user, version.asset.projectId);

    const rel = kind === 'original' ? version.filePath : version.renditions.find((r) => r.kind === kind)?.filePath;
    if (!rel) throw httpError(404, '文件不存在');

    if (kind === 'original') {
      await audit(user.id, 'download', `版本 ${version.asset.name}-v${version.versionNo}（原片）`, req.ip, { name: version.originalName }, { type: 'version', id: versionId });
      reply.header('content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(version.originalName)}`);
      // 本地有文件（local 后端或归档失败保留的副本）直接发
      if (await localExists(rel)) {
        return reply.sendFile(rel, mediaDir(), { maxAge: 0, cacheControl: false });
      }
      // 远端回源：WebDAV 直接流式代理（零落盘），FTP 先落临时文件再发
      if ((await backend()) === 'local') throw httpError(404, '文件不存在');
      try {
        const { stream, size } = await (await storage()).stream(rel);
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'none',
          ...(size ? { 'content-length': size } : {}),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(version.originalName)}`,
        });
        stream.pipe(reply.raw);
      } catch {
        if (!reply.raw.headersSent) reply.raw.writeHead(404);
        reply.raw.end();
      }
      return;
    }
    return reply.sendFile(rel, mediaDir(), { maxAge: '1h' });
  });

  // 项目封面（资产列表用最新版本封面）
  app.get('/api/assets/:assetId/poster', async (req, reply) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1, include: { renditions: true } } },
    });
    if (!asset) throw httpError(404, '资产不存在');
    await requireMember(user, asset.projectId);
    const poster = asset.versions[0]?.renditions.find((r) => r.kind === 'poster');
    if (!poster) throw httpError(404, '暂无封面');
    return reply.sendFile(poster.filePath, mediaDir(), { maxAge: '1h' });
  });

  /** 按需抽单帧：无 w 为全分辨率（大图弹窗），带 w 为缩略小图（网格每帧独立 img） */
  app.get('/api/media/:versionId/frame', async (req, reply) => {
    const user = await requireAuth(req);
    const { versionId } = req.params as { versionId: string };
    const q = req.query as { t?: string; w?: string };
    const t = Number(q.t ?? 0);
    if (!isFinite(t) || t < 0) throw httpError(400, 't 参数无效');
    const w = q.w !== undefined ? Number(q.w) : null;
    if (w !== null && (!Number.isInteger(w) || w < 32 || w > 3840)) throw httpError(400, 'w 参数无效');
    const version = await prisma.assetVersion.findUnique({
      where: { id: versionId }, include: { asset: true, renditions: true },
    });
    if (!version) throw httpError(404, '版本不存在');
    await requireMember(user, version.asset.projectId);
    const proxy = version.renditions.find((r) => r.kind === 'proxy')?.filePath;
    if (!proxy) throw httpError(404, '转码未完成');
    const cacheRel = await extractFrame(proxy, versionId, t, w);
    return reply.sendFile(cacheRel, mediaDir(), { maxAge: '1d' });
  });

  /**
   * 批量预生成网格帧缩略图：一次 ffmpeg 解码 pass 按雪碧图间隔产出全部小图，
   * 避免首屏几十个 <img> 各自触发一次 -ss 抽帧。幂等：全部命中缓存时直接返回。
   * fps 滤镜第 i 张（从 0 计）对应 t = i * intervalSec，与雪碧图格子一致。
   */
  app.get('/api/media/:versionId/frames-batch', async (req, reply) => {
    const user = await requireAuth(req);
    const { versionId } = req.params as { versionId: string };
    const w = Number((req.query as { w?: string })?.w ?? 160);
    if (!Number.isInteger(w) || w < 32 || w > 3840) throw httpError(400, 'w 参数无效');
    const version = await prisma.assetVersion.findUnique({
      where: { id: versionId }, include: { asset: true, renditions: true },
    });
    if (!version) throw httpError(404, '版本不存在');
    await requireMember(user, version.asset.projectId);
    const proxy = version.renditions.find((r) => r.kind === 'proxy')?.filePath;
    if (!proxy) throw httpError(404, '转码未完成');
    const meta = version.renditions.find((r) => r.kind === 'sprite')?.meta as any;
    const interval = Number(meta?.intervalSec);
    const count = Math.floor(Number(meta?.count));
    if (!isFinite(interval) || interval <= 0 || !isFinite(count) || count <= 0) {
      throw httpError(404, '雪碧图未生成');
    }

    const framesDir = path.join(mediaDir(), 'renditions', versionId, 'frames');
    const nameAt = (i: number) => `t${(i * interval).toFixed(2)}_w${w}.jpg`;
    const expected = Array.from({ length: count }, (_, i) => nameAt(i));
    const readyCount = () => expected.filter((n) => fs.existsSync(path.join(framesDir, n))).length;
    if (readyCount() === count) {
      return reply.header('cache-control', 'no-store').send({ ok: true, count, cached: true });
    }

    const key = `${versionId}:${w}`;
    let p = batchInflight.get(key);
    if (!p) {
      p = (async () => {
        const tmpDir = path.join(framesDir, `_batch_w${w}`);
        await fsp.rm(tmpDir, { recursive: true, force: true });
        await fsp.mkdir(tmpDir, { recursive: true });
        const res = await run(FFMPEG, [
          '-v', 'error', '-i', path.join(mediaDir(), proxy),
          '-vf', `fps=1/${interval},scale=${w}:-2`,
          '-frames:v', String(count), '-q:v', '6',
          path.join(tmpDir, 'f_%05d.jpg'),
        ], { maxBuffer: 200_000 });
        if (res.code !== 0) {
          await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          throw httpError(500, `批量抽帧失败: ${res.stderr.split('\n').slice(-3).join(' ')}`);
        }
        const files = (await fsp.readdir(tmpDir)).filter((f) => f.endsWith('.jpg')).sort();
        for (let i = 0; i < files.length && i < count; i++) {
          const f = files[i];
          if (f) await fsp.rename(path.join(tmpDir, f), path.join(framesDir, nameAt(i)));
        }
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        return readyCount();
      })();
      batchInflight.set(key, p);
      p.catch(() => {}).finally(() => batchInflight.delete(key));
    }
    const done = await p;
    return reply.header('cache-control', 'no-store').send({ ok: true, count: done, cached: false });
  });
}
