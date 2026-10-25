import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAdmin, httpError } from '../auth/guards.js';
import { diskFree } from '../util.js';
import { mediaDir } from '../env.js';
import { enqueueTranscode } from '../jobs.js';
import { audit } from '../audit.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { await requireAdmin(req); });

  /* 项目总览 */
  app.get('/api/admin/overview', async () => {
    const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
    const counts = await prisma.projectMember.groupBy({ by: ['projectId'], _count: { userId: true } });
    const countMap = new Map(counts.map((c) => [c.projectId, c._count.userId]));
    const versionAgg = await prisma.assetVersion.groupBy({
      by: ['assetId'], _sum: { size: true },
    });
    const assetAgg = await prisma.assetVersion.aggregate({ _sum: { size: true } });
    const versionSize = new Map<string, number>();
    for (const row of versionAgg) versionSize.set(row.assetId, Number(row._sum.size ?? 0));
    const assets = await prisma.asset.findMany({ select: { id: true, projectId: true, updatedAt: true, deletedAt: true } });
    const perProject = new Map<string, { assets: number; bytes: number; lastActivity: Date | null }>();
    for (const a of assets) {
      const rec = perProject.get(a.projectId) ?? { assets: 0, bytes: 0, lastActivity: null };
      if (!a.deletedAt) {
        rec.assets += 1;
        rec.bytes += versionSize.get(a.id) ?? 0;
        if (!rec.lastActivity || a.updatedAt > rec.lastActivity) rec.lastActivity = a.updatedAt;
      }
      perProject.set(a.projectId, rec);
    }
    const rendAgg = await prisma.rendition.aggregate({ _sum: { size: true } });
    const managers = await prisma.projectMember.findMany({ where: { role: 'manager' }, include: { user: { select: { name: true } } } });
    const managerMap = new Map<string, string[]>();
    for (const m of managers) {
      managerMap.set(m.projectId, [...(managerMap.get(m.projectId) ?? []), m.user.name]);
    }
    /* 最近操作人：合并所有可归属到项目的操作事件，取每个项目最新一条的操作者。
       事件源 = 审计日志（项目设置/成员/下载/导出/回收站/删批注等，targetType/targetId 关联回项目）
              + 未写审计的内容操作（上传 AssetVersion、发批注/解决批注 Comment、关联帧 FrameLink）。
       注意：素材重命名/描述编辑没有记录操作者，不计入。 */
    const lastActors = await prisma.$queryRaw<{ pid: string; actorName: string | null }[]>`
      WITH aud AS MATERIALIZED (
        SELECT "targetType", "targetId", "actorId", "createdAt" FROM "AuditLog"
        WHERE "targetId" IS NOT NULL
          AND "targetType" IN ('project', 'version', 'asset', 'comment', 'framelink')
      ),
      events(pid, actor, at) AS (
        SELECT a."targetId", a."actorId", a."createdAt"
        FROM aud a WHERE a."targetType" = 'project'
        UNION ALL
        SELECT ast."projectId", a."actorId", a."createdAt"
        FROM aud a
        JOIN "AssetVersion" v ON v.id = a."targetId"
        JOIN "Asset" ast ON ast.id = v."assetId"
        WHERE a."targetType" = 'version'
        UNION ALL
        SELECT ast."projectId", a."actorId", a."createdAt"
        FROM aud a
        JOIN "Asset" ast ON ast.id = a."targetId"
        WHERE a."targetType" = 'asset'
        UNION ALL
        SELECT ast."projectId", a."actorId", a."createdAt"
        FROM aud a
        JOIN "Comment" c ON c.id = a."targetId"
        JOIN "AssetVersion" v ON v.id = c."versionId"
        JOIN "Asset" ast ON ast.id = v."assetId"
        WHERE a."targetType" = 'comment'
        UNION ALL
        SELECT ast."projectId", a."actorId", a."createdAt"
        FROM aud a
        JOIN "FrameLink" fl ON fl.id = a."targetId"
        JOIN "Asset" ast ON ast.id = fl."assetId"
        WHERE a."targetType" = 'framelink'
        UNION ALL
        SELECT ast."projectId", v."uploadedBy", v."createdAt"
        FROM "AssetVersion" v JOIN "Asset" ast ON ast.id = v."assetId"
        WHERE v."uploadedBy" IS NOT NULL
        UNION ALL
        SELECT ast."projectId", c."authorId", c."createdAt"
        FROM "Comment" c
        JOIN "AssetVersion" v ON v.id = c."versionId"
        JOIN "Asset" ast ON ast.id = v."assetId"
        UNION ALL
        SELECT ast."projectId", c."resolvedBy", c."resolvedAt"
        FROM "Comment" c
        JOIN "AssetVersion" v ON v.id = c."versionId"
        JOIN "Asset" ast ON ast.id = v."assetId"
        WHERE c."resolvedBy" IS NOT NULL AND c."resolvedAt" IS NOT NULL
        UNION ALL
        SELECT ast."projectId", fl."createdBy", fl."createdAt"
        FROM "FrameLink" fl JOIN "Asset" ast ON ast.id = fl."assetId"
      )
      SELECT DISTINCT ON (e.pid) e.pid, u.name AS "actorName"
      FROM events e
      LEFT JOIN "User" u ON u.id = e.actor
      ORDER BY e.pid, e.at DESC`;
    const lastActorMap = new Map(lastActors.map((r) => [r.pid, r.actorName]));
    return {
      projects: projects.map((p) => ({
        id: p.id, name: p.name, archived: !!p.archivedAt, createdAt: p.createdAt,
        memberCount: countMap.get(p.id) ?? 0,
        managers: managerMap.get(p.id) ?? [],
        assetCount: perProject.get(p.id)?.assets ?? 0,
        bytes: perProject.get(p.id)?.bytes ?? 0,
        lastActivity: perProject.get(p.id)?.lastActivity ?? null,
        lastActor: lastActorMap.get(p.id) ?? null,
      })),
      totals: {
        versionBytes: Number(assetAgg._sum.size ?? 0),
        renditionBytes: Number(rendAgg._sum.size ?? 0),
      },
    };
  });

  /* 存储监控 */
  app.get('/api/admin/storage', async () => {
    const disk = await diskFree(mediaDir());
    const { backendLabel } = await import('../storage.js');
    const { getSetting } = await import('./settings-service.js');
    const general = await getSetting<any>('general');
    const backend = await backendLabel();
    const overview = await prisma.project.findMany({ select: { id: true, name: true } });
    const versionAgg = await prisma.assetVersion.groupBy({
      by: ['assetId'], _sum: { size: true },
    });
    const sizeByAsset = new Map(versionAgg.map((r) => [r.assetId, Number(r._sum.size ?? 0)]));
    const assets = await prisma.asset.findMany({ where: { deletedAt: null }, select: { id: true, projectId: true } });
    const byProject = new Map<string, number>();
    for (const a of assets) byProject.set(a.projectId, (byProject.get(a.projectId) ?? 0) + (sizeByAsset.get(a.id) ?? 0));
    const rendAgg = await prisma.rendition.aggregate({ _sum: { size: true } });
    const lowSpace = !!disk && disk.free < disk.total * (general.diskWarnPercent / 100);
    return {
      disk,
      lowSpace,
      storageBackend: backend,
      projects: overview.map((p) => ({ id: p.id, name: p.name, bytes: byProject.get(p.id) ?? 0 })),
      renditionBytes: Number(rendAgg._sum.size ?? 0),
    };
  });

  /* 转码任务 */
  app.get('/api/admin/transcodes', async () => {
    const versions = await prisma.assetVersion.findMany({
      where: { status: { in: ['queued', 'transcoding', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { asset: { select: { name: true, projectId: true } }, uploader: { select: { name: true } } },
    });
    return {
      tasks: versions.map((v) => ({
        versionId: v.id, assetName: v.asset.name, versionNo: v.versionNo, status: v.status,
        progress: v.progress, error: v.error, createdAt: v.createdAt,
        uploadedBy: v.uploader?.name ?? null, size: Number(v.size),
      })),
    };
  });

  app.post('/api/admin/transcodes/:versionId/retry', async (req) => {
    const { versionId } = req.params as { versionId: string };
    const version = await prisma.assetVersion.findUnique({
      where: { id: versionId }, include: { asset: { select: { name: true } } },
    });
    if (!version) throw httpError(404, '版本不存在');
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: { status: 'queued', progress: 0, error: null, transcodeAttempts: 0 },
    });
    await enqueueTranscode(versionId);
    await audit(req.user!.id, 'transcode.retry', `版本 ${version.asset.name}-v${version.versionNo}`, req.ip, undefined, { type: 'version', id: versionId });
    return { ok: true };
  });

  /* 审计日志 */
  app.get('/api/admin/audit', async (req) => {
    const q = req.query as { actorId?: string; action?: string; from?: string; to?: string; page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 20));
    const where: Record<string, unknown> = {};
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = { contains: q.action };
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T23:59:59`) } : {}),
      };
    }
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
        include: { actor: { select: { name: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    return {
      items: items.map((i) => ({ ...i, actorName: i.actor?.name ?? null, actorEmail: i.actor?.email ?? null })),
      total, page,
    };
  });
}
