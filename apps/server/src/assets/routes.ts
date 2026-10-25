import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAuth, requireProjectRole, httpError } from '../auth/guards.js';
import { createFolderSchema, renameSchema, moveAssetSchema, reviewStatusSchema } from '@frametalk/shared';
import { audit } from '../audit.js';
import { assetToDto, versionToDto } from './dto.js';
import { emitEvent } from '../notify/events.js';

const versionInclude = {
  renditions: true,
  uploader: { select: { name: true } },
} as const;

export async function assetRoutes(app: FastifyInstance) {
  /* ---------- 文件夹 ---------- */
  app.post('/api/projects/:id/folders', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'editor');
    const input = createFolderSchema.parse(req.body);
    if (input.parentId) {
      const parent = await prisma.folder.findFirst({ where: { id: input.parentId, projectId: id, deletedAt: null } });
      if (!parent) throw httpError(400, '父文件夹无效');
    }
    const folder = await prisma.folder.create({
      data: { projectId: id, name: input.name, parentId: input.parentId ?? null },
    });
    return { id: folder.id };
  });

  app.get('/api/projects/:id/folders', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'viewer');
    const folders = await prisma.folder.findMany({
      where: { projectId: id, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }],
    });
    return { folders: folders.map((f) => ({ id: f.id, projectId: f.projectId, parentId: f.parentId, name: f.name })) };
  });

  app.patch('/api/folders/:folderId', async (req) => {
    const user = await requireAuth(req);
    const { folderId } = req.params as { folderId: string };
    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder) throw httpError(404, '文件夹不存在');
    await requireProjectRole(user, folder.projectId, 'editor');
    const body = renameSchema.partial().parse(req.body ?? {});
    if (body.name) await prisma.folder.update({ where: { id: folderId }, data: { name: body.name } });
    emitEvent({ type: 'project:update', projectId: folder.projectId });
    return { ok: true };
  });

  app.delete('/api/folders/:folderId', async (req) => {
    const user = await requireAuth(req);
    const { folderId } = req.params as { folderId: string };
    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder) throw httpError(404, '文件夹不存在');
    await requireProjectRole(user, folder.projectId, 'editor');
    await prisma.folder.update({ where: { id: folderId }, data: { deletedAt: new Date() } });
    await prisma.asset.updateMany({ where: { folderId }, data: { deletedAt: new Date() } });
    emitEvent({ type: 'project:update', projectId: folder.projectId });
    return { ok: true };
  });

  /* ---------- 资产列表与详情 ---------- */
  app.get('/api/projects/:id/assets', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'viewer');
    const q = req.query as { folderId?: string; trash?: string; search?: string };
    const where: Record<string, unknown> = { projectId: id };
    if (q.trash === '1') where.deletedAt = { not: null };
    else {
      where.deletedAt = null;
      where.folderId = q.folderId ?? null;
    }
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' };
    const assets = await prisma.asset.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { versions: { include: versionInclude, orderBy: { versionNo: 'desc' } } },
    });
    return { assets: assets.map(assetToDto) };
  });

  app.get('/api/assets/:assetId', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { versions: { include: versionInclude, orderBy: { versionNo: 'desc' } } },
    });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'viewer');
    return { asset: assetToDto(asset), versions: asset.versions.map(versionToDto) };
  });

  app.patch('/api/assets/:assetId', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'editor');
    const body = req.body as { name?: string; folderId?: string | null; description?: string | null };
    const data: { name?: string; description?: string | null } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) {
      data.description = typeof body.description === 'string' ? body.description.slice(0, 2000) || null : null;
    }
    if (Object.keys(data).length) {
      await prisma.asset.update({ where: { id: assetId }, data });
    }
    emitEvent({ type: 'asset:update', projectId: asset.projectId, assetId });
    return { ok: true };
  });

  app.post('/api/assets/:assetId/trash', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'editor');
    await prisma.asset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });
    await audit(user.id, 'asset.trash', `素材「${asset.name}」`, req.ip, undefined, { type: 'asset', id: assetId });
    emitEvent({ type: 'asset:update', projectId: asset.projectId, assetId });
    return { ok: true };
  });

  app.post('/api/assets/:assetId/restore', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'editor');
    await prisma.asset.update({ where: { id: assetId }, data: { deletedAt: null } });
    emitEvent({ type: 'asset:update', projectId: asset.projectId, assetId });
    return { ok: true };
  });

  /* ---------- 审阅状态 ---------- */
  app.patch('/api/assets/:assetId/review-status', async (req) => {
    const user = await requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw httpError(404, '资产不存在');
    await requireProjectRole(user, asset.projectId, 'reviewer');
    const input = reviewStatusSchema.parse(req.body);
    await prisma.asset.update({ where: { id: assetId }, data: { reviewStatus: input.status } });
    emitEvent({ type: 'status:change', projectId: asset.projectId, assetId, status: input.status, by: user.name });
    return { ok: true };
  });
}
