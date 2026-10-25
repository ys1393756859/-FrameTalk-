import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAuth, requireProjectRole, httpError } from '../auth/guards.js';
import { createProjectSchema, addMemberSchema, updateMemberSchema } from '@frametalk/shared';
import { audit } from '../audit.js';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { mediaDir } from '../env.js';

async function projectSizeBytes(projectId: string): Promise<number> {
  const agg = await prisma.assetVersion.aggregate({
    where: { asset: { projectId } }, _sum: { size: true },
  });
  const rend = await prisma.rendition.aggregate({
    where: { version: { asset: { projectId } } }, _sum: { size: true },
  });
  return Number(agg._sum.size ?? 0) + Number(rend._sum.size ?? 0);
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req) => {
    const user = await requireAuth(req);
    const projects = user.isAdmin
      ? await prisma.project.findMany({ orderBy: { createdAt: 'desc' } })
      : await prisma.project.findMany({
          where: { members: { some: { userId: user.id } } },
          orderBy: { createdAt: 'desc' },
        });
    const memberships = await prisma.projectMember.findMany({ where: { userId: user.id } });
    const roleMap = new Map(memberships.map((m) => [m.projectId, m.role]));
    const counts = await prisma.projectMember.groupBy({ by: ['projectId'], _count: { userId: true } });
    const countMap = new Map(counts.map((c) => [c.projectId, c._count.userId]));
    return {
      projects: projects.map((p) => ({
        id: p.id, name: p.name, kind: p.kind, description: p.description, archivedAt: p.archivedAt,
        createdAt: p.createdAt,
        myRole: user.isAdmin && !roleMap.has(p.id) ? 'admin' : roleMap.get(p.id) ?? 'admin',
        memberCount: countMap.get(p.id) ?? 0,
      })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const user = await requireAuth(req);
    if (!user.isAdmin) throw httpError(403, '只有管理员可以创建项目');
    const input = createProjectSchema.parse(req.body);
    const exists = await prisma.project.findUnique({ where: { name: input.name } });
    if (exists) return reply.status(409).send({ message: '项目名已存在' });
    const project = await prisma.project.create({
      data: {
        name: input.name, kind: input.kind ?? 'self', description: input.description,
        members: { create: { userId: user.id, role: 'manager' } },
      },
    });
    await audit(user.id, 'project.create', `项目「${project.name}」`, req.ip, undefined, { type: 'project', id: project.id });
    return { id: project.id };
  });

  app.get('/api/projects/:id', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const role = await requireProjectRole(user, id, 'viewer');
    const p = await prisma.project.findUnique({
      where: { id },
      include: { members: { include: { user: { select: { id: true, name: true, email: true, isAdmin: true, title: true } } } } },
    });
    if (!p) throw httpError(404, '项目不存在');
      return {
        project: {
          id: p.id, name: p.name, kind: p.kind, description: p.description, archivedAt: p.archivedAt,
        customLabels: (p.customLabels as any) ?? [],
        createdAt: p.createdAt, myRole: role,
        members: p.members.map((m) => ({ userId: m.userId, role: m.role, name: m.user.name, email: m.user.email })),
      },
    };
  });

  app.patch('/api/projects/:id', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'manager');
    const input = createProjectSchema.partial().parse(req.body);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.description !== undefined) data.description = input.description;
    const cl = (req.body as any)?.customLabels;
    if (cl !== undefined) {
      if (!Array.isArray(cl) || cl.length > 20
        || cl.some((x: any) => typeof x?.name !== 'string' || !x.name || x.name.length > 10 || typeof x?.color !== 'string')) {
        throw httpError(400, 'customLabels 格式不正确（[{name<=10,color}]，最多 20 个）');
      }
      data.customLabels = cl;
    }
    if (typeof (req.body as any)?.archived === 'boolean') {
      data.archivedAt = (req.body as any).archived ? new Date() : null;
    }
    const updated = await prisma.project.update({ where: { id }, data });
    await audit(user.id, 'project.update', `项目「${updated.name}」`, req.ip, undefined, { type: 'project', id });
    return { ok: true };
  });

  app.delete('/api/projects/:id', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'manager');
    const assets = await prisma.asset.findMany({
      where: { projectId: id }, include: { versions: true },
    });
    for (const a of assets) for (const v of a.versions) {
      await fsp.rm(path.join(mediaDir(), 'originals', v.id), { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.join(mediaDir(), 'renditions', v.id), { recursive: true, force: true }).catch(() => {});
    }
    const deleted = await prisma.project.delete({ where: { id } });
    await audit(user.id, 'project.delete', `项目「${deleted.name}」`, req.ip, { assetCount: assets.length }, { type: 'project', id });
    return { ok: true };
  });

  app.get('/api/projects/:id/members', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'viewer');
    const members = await prisma.projectMember.findMany({
      where: { projectId: id },
      include: { user: { select: { id: true, name: true, email: true, title: true } } },
    });
    return { members: members.map((m) => ({ userId: m.userId, role: m.role, name: m.user.name, email: m.user.email })) };
  });

  /** 成员选择器：还没加入项目的用户 */
  app.get('/api/projects/:id/non-members', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'manager');
    const members = await prisma.projectMember.findMany({ where: { projectId: id }, select: { userId: true } });
    const ids = members.map((m) => m.userId);
    const users = await prisma.user.findMany({
      where: { id: { notIn: ids }, disabledAt: null },
      select: { id: true, name: true, email: true, title: true },
      orderBy: { name: 'asc' },
    });
    return { users };
  });

  app.post('/api/projects/:id/members', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'manager');
    const input = addMemberSchema.parse(req.body);
    const exists = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: input.userId } },
    });
    if (exists) throw httpError(409, '已是项目成员');
    await prisma.projectMember.create({ data: { projectId: id, userId: input.userId, role: input.role } });
    const [proj, member] = await Promise.all([
      prisma.project.findUnique({ where: { id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
    ]);
    await audit(user.id, 'member.add', `项目「${proj?.name ?? '未知'}」· 成员「${member?.name ?? '未知'}」`, req.ip, { userId: input.userId, role: input.role }, { type: 'project', id });
    return { ok: true };
  });

  app.patch('/api/projects/:id/members/:userId', async (req) => {
    const user = await requireAuth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    await requireProjectRole(user, id, 'manager');
    const input = updateMemberSchema.parse(req.body);
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: id, userId } },
      data: { role: input.role },
    });
    const [proj, member] = await Promise.all([
      prisma.project.findUnique({ where: { id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    await audit(user.id, 'member.role', `项目「${proj?.name ?? '未知'}」· 成员「${member?.name ?? '未知'}」`, req.ip, { userId, role: input.role }, { type: 'project', id });
    return { ok: true };
  });

  app.delete('/api/projects/:id/members/:userId', async (req) => {
    const user = await requireAuth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    await requireProjectRole(user, id, 'manager');
    const managers = await prisma.projectMember.count({ where: { projectId: id, role: 'manager' } });
    const target = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId } },
    });
    if (!target) throw httpError(404, '成员不存在');
    if (target.role === 'manager' && managers <= 1) throw httpError(400, '项目至少保留一名管理者');
    await prisma.projectMember.delete({ where: { projectId_userId: { projectId: id, userId } } });
    const [proj, member] = await Promise.all([
      prisma.project.findUnique({ where: { id }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    await audit(user.id, 'member.remove', `项目「${proj?.name ?? '未知'}」· 成员「${member?.name ?? '未知'}」`, req.ip, { userId }, { type: 'project', id });
    return { ok: true };
  });

  app.get('/api/projects/:id/storage', async (req) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    await requireProjectRole(user, id, 'manager');
    return { bytes: await projectSizeBytes(id) };
  });
}
