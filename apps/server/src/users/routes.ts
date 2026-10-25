import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAdmin } from '../auth/guards.js';
import { hashPassword } from '../auth/password.js';
import { destroyUserSessions } from '../auth/session.js';
import { createUserSchema, updateUserSchema } from '@frametalk/shared';
import { audit } from '../audit.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { await requireAdmin(req); });

  app.get('/api/users', async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, email: true, phone: true, isAdmin: true, title: true,
        mustChangePassword: true, disabledAt: true, createdAt: true,
        _count: { select: { memberships: true } },
      },
    });
    return { users: users.map((u) => ({ ...u, disabled: !!u.disabledAt, projectCount: u._count.memberships })) };
  });

  app.post('/api/users', async (req, reply) => {
    const input = createUserSchema.parse(req.body);
    if (input.email) {
      const exists = await prisma.user.findUnique({ where: { email: input.email } });
      if (exists) return reply.status(409).send({ message: '邮箱已存在' });
    }
    if (input.phone) {
      const exists = await prisma.user.findUnique({ where: { phone: input.phone } });
      if (exists) return reply.status(409).send({ message: '手机号已被使用' });
    }
    const user = await prisma.user.create({
      data: {
        name: input.name, email: input.email ?? null, phone: input.phone ?? null,
        isAdmin: input.isAdmin,
        title: input.title ?? null,
        passwordHash: await hashPassword(input.password),
        mustChangePassword: true,
      },
    });
    await audit(req.user!.id, 'user.create', `用户「${user.name}」`, req.ip, { email: input.email, phone: input.phone, title: input.title }, { type: 'user', id: user.id });
    return { id: user.id };
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = updateUserSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.status(404).send({ message: '用户不存在' });
    if (target.isAdmin && input.isAdmin === false && target.id === req.user!.id) {
      return reply.status(400).send({ message: '不能取消自己的管理员权限' });
    }
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.email !== undefined) {
      if (input.email && input.email !== target.email) {
        const exists = await prisma.user.findUnique({ where: { email: input.email } });
        if (exists) return reply.status(409).send({ message: '邮箱已存在' });
      }
      data.email = input.email; // null = 清空邮箱
    }
    if (input.phone !== undefined) {
      if (input.phone && input.phone !== target.phone) {
        const exists = await prisma.user.findUnique({ where: { phone: input.phone } });
        if (exists) return reply.status(409).send({ message: '手机号已被使用' });
      }
      data.phone = input.phone; // null = 清空手机号
    }
    if (input.isAdmin !== undefined) data.isAdmin = input.isAdmin;
    if (input.title !== undefined) data.title = input.title ?? null;
    if (input.disabled !== undefined) data.disabledAt = input.disabled ? new Date() : null;
    if (input.newPassword !== undefined) {
      data.passwordHash = await hashPassword(input.newPassword);
      data.mustChangePassword = true;
    }
    // 邮箱/手机至少留一个登录账号
    const nextEmail = (data.email ?? target.email) as string | null | undefined;
    const nextPhone = (data.phone ?? target.phone) as string | null | undefined;
    if (!nextEmail && !nextPhone) {
      return reply.status(400).send({ message: '邮箱和手机号至少保留一个' });
    }
    await prisma.user.update({ where: { id }, data });
    if (input.disabled || input.newPassword !== undefined) {
      await destroyUserSessions(id); // 禁用/重置密码立即踢下线
    }
    await audit(req.user!.id, 'user.update', `用户「${input.name ?? target.name}」`, req.ip, { ...input, newPassword: input.newPassword ? '***' : undefined }, { type: 'user', id });
    return { ok: true };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.status(404).send({ message: '用户不存在' });
    if (id === req.user!.id) return reply.status(400).send({ message: '不能删除自己' });
    if (target.isAdmin) {
      const admins = await prisma.user.count({ where: { isAdmin: true, disabledAt: null, id: { not: id } } });
      if (admins === 0) return reply.status(400).send({ message: '系统至少保留一名可用的管理员' });
    }
    await prisma.user.delete({ where: { id } }); // 关联表均 Cascade，成员/会话/通知随之清理
    await audit(req.user!.id, 'user.delete', `用户「${target.name}」`, req.ip, { email: target.email }, { type: 'user', id });
    return { ok: true };
  });
}
