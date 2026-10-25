import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guards.js';

export async function notifyRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    const user = await requireAuth(req);
    const q = req.query as { tab?: string; page?: string; pageSize?: string };
    const tab: 'unread' | 'read' = q.tab === 'read' ? 'read' : 'unread';
    const pageSize = Math.min(50, Math.max(1, Number(q.pageSize) || 10));
    const page = Math.max(1, Number(q.page) || 1);
    const where = {
      userId: user.id,
      ...(tab === 'unread' ? { readAt: null } : { readAt: { not: null } }),
    };
    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    // 历史通知 payload 缺 projectId（2026-10-25 前的数据）：按 assetId 批量回填，保证前端能跳转
    const missing = new Set<string>();
    for (const n of items) {
      const p = n.payload as any;
      if (p && !p.projectId && typeof p.assetId === 'string') missing.add(p.assetId);
    }
    let projOf = new Map<string, string>();
    if (missing.size) {
      const assets = await prisma.asset.findMany({
        where: { id: { in: [...missing] } }, select: { id: true, projectId: true },
      });
      projOf = new Map(assets.map((a) => [a.id, a.projectId]));
    }
    return {
      notifications: items.map((n) => {
        const p = n.payload as any;
        if (p && !p.projectId && typeof p.assetId === 'string' && projOf.has(p.assetId)) {
          return { ...n, payload: { ...p, projectId: projOf.get(p.assetId) } };
        }
        return { ...n, payload: p };
      }),
      unread, total, page, pageSize,
    };
  });

  app.post('/api/notifications/read', async (req) => {
    const user = await requireAuth(req);
    const input = z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }).parse(req.body);
    if (input.all) {
      await prisma.notification.updateMany({
        where: { userId: user.id, readAt: null }, data: { readAt: new Date() },
      });
    } else if (input.ids?.length) {
      await prisma.notification.updateMany({
        where: { userId: user.id, id: { in: input.ids } }, data: { readAt: new Date() },
      });
    }
    return { ok: true };
  });
}
