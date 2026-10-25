import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAuth, requireProjectRole, httpError } from '../auth/guards.js';
import { createFrameLinkSchema } from '@frametalk/shared';
import { emitEvent } from '../notify/events.js';
import { audit } from '../audit.js';
import type { FrameLinkDto } from '@frametalk/shared';
import type { FrameLink } from '@prisma/client';

type FrameLinkWithCreator = FrameLink & { creator: { name: string } };

function toDto(l: FrameLinkWithCreator): FrameLinkDto {
  return {
    id: l.id,
    assetId: l.assetId,
    baseVersionId: l.baseVersionId,
    baseFrame: l.baseFrame,
    versionId: l.versionId,
    frame: l.frame,
    note: l.note,
    createdBy: l.createdBy,
    creatorName: l.creator.name,
    createdAt: l.createdAt.toISOString(),
  };
}

const withCreator = { creator: { select: { name: true } } } as const;

export async function frameLinkRoutes(app: FastifyInstance) {
  app.get('/api/assets/:assetId/frame-links', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'viewer');
    const links = await prisma.frameLink.findMany({
      where: { assetId },
      orderBy: [{ baseFrame: 'asc' }, { createdAt: 'asc' }],
      include: withCreator,
    });
    return { links: links.map(toDto) };
  });

  app.post('/api/assets/:assetId/frame-links', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'reviewer');
    const input = createFrameLinkSchema.parse(req.body);

    if (input.baseVersionId === input.versionId) {
      throw httpError(400, '不能关联同一版本');
    }
    const [base, target, latest] = await Promise.all([
      prisma.assetVersion.findFirst({ where: { id: input.baseVersionId, assetId } }),
      prisma.assetVersion.findFirst({ where: { id: input.versionId, assetId } }),
      prisma.assetVersion.findFirst({ where: { assetId }, orderBy: { versionNo: 'desc' }, select: { id: true } }),
    ]);
    if (!base || !target) throw httpError(400, '版本不属于该资产');
    // 主版本必须是最新版（批注与关联帧统一锚定最新版）
    if (latest && latest.id !== base.id) {
      throw httpError(400, '关联帧的主版本必须是最新版本');
    }
    if (base.frameCount != null && input.baseFrame > base.frameCount) {
      throw httpError(400, `主版本帧号超出范围（总帧数 ${base.frameCount}）`);
    }
    if (target.frameCount != null && input.frame > target.frameCount) {
      throw httpError(400, `对比版本帧号超出范围（总帧数 ${target.frameCount}）`);
    }

    const exists = await prisma.frameLink.findUnique({
      where: {
        baseVersionId_baseFrame_versionId_frame: {
          baseVersionId: input.baseVersionId, baseFrame: input.baseFrame,
          versionId: input.versionId, frame: input.frame,
        },
      },
      include: withCreator,
    });
    if (exists) return { link: toDto(exists), duplicate: true };

    const link = await prisma.frameLink.create({
      data: {
        assetId,
        baseVersionId: input.baseVersionId,
        baseFrame: input.baseFrame,
        versionId: input.versionId,
        frame: input.frame,
        note: input.note ?? null,
        createdBy: user.id,
      },
      include: withCreator,
    });
    emitEvent({ type: 'framelink:new', projectId: asset.projectId, assetId, link: toDto(link) });
    return { link: toDto(link) };
  });

  app.delete('/api/frame-links/:linkId', async (req) => {
    const user = await requireAuth(req);
    const { linkId } = req.params as { linkId: string };
    const link = await prisma.frameLink.findUnique({ where: { id: linkId }, include: { asset: true } });
    if (!link) throw httpError(404, '关联帧不存在');
    const role = await requireProjectRole(user, link.asset.projectId, 'viewer');
    if (link.createdBy !== user.id && role !== 'manager' && role !== 'admin') {
      throw httpError(403, '只有创建者或管理者可以删除');
    }
    await prisma.frameLink.delete({ where: { id: linkId } });
    await audit(user.id, 'framelink.delete', `帧关联 · 素材「${link.asset.name}」（帧 ${link.baseFrame} ↔ ${link.frame}）`, req.ip, undefined, { type: 'framelink', id: linkId });
    emitEvent({ type: 'framelink:delete', projectId: link.asset.projectId, assetId: link.assetId, deleted: { id: linkId } });
    return { ok: true };
  });
}
