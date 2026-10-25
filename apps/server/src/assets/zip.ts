import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import path from 'node:path';
import { prisma } from '../db.js';
import { mediaDir } from '../env.js';
import { requireAuth, requireProjectRole } from '../auth/guards.js';
import { audit } from '../audit.js';
import { ensureLocal } from '../storage.js';

/** 批量下载原片 zip（流式打包；远端归档的原片先回源到本地再入包） */
export async function zipRoutes(app: FastifyInstance) {
  app.get('/api/projects/:id/download-zip', async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'viewer');
    const ids = String((req.query as any).ids ?? '').split(',').filter(Boolean);
    if (!ids.length) return reply.status(400).send({ message: '缺少 ids' });
    const assets = await prisma.asset.findMany({
      where: { id: { in: ids }, projectId: id },
      include: { versions: { orderBy: { versionNo: 'desc' } } },
    });
    if (!assets.length) return reply.status(404).send({ message: '没有可下载的资产' });

    // 远端原片回源（本地后端为空操作）
    for (const asset of assets) {
      const latest = asset.versions[0];
      if (latest) await ensureLocal(latest.filePath).catch(() => {});
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('batch.zip')}`,
    });
    const archive = archiver('zip', { zlib: { level: 0 } }); // 原片已压缩，level 0 最快
    archive.pipe(reply.raw);
    const used = new Set<string>();
    for (const asset of assets) {
      const latest = asset.versions[0];
      if (!latest) continue;
      let name = `${asset.name}/v${latest.versionNo}-${latest.originalName}`;
      while (used.has(name)) name = `${path.parse(name).name}(1)${path.extname(name)}`;
      used.add(name);
      archive.file(path.join(mediaDir(), latest.filePath), { name });
    }
    await archive.finalize();
    const project = await prisma.project.findUnique({ where: { id }, select: { name: true } });
    await audit(user.id, 'download.zip', `项目「${project?.name ?? '未知'}」· ${assets.length} 个素材`, req.ip, { assets: ids.length }, { type: 'project', id });
  });
}
