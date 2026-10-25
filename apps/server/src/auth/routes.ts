import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { verifyPassword, hashPassword } from './password.js';
import { createSession, destroySession } from './session.js';
import { checkLocked, recordFailure, clearFailures } from './rateLimit.js';
import { requireAuth } from './guards.js';
import { loginSchema, changePasswordSchema } from '@frametalk/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import { getSetting } from '../admin/settings-service.js';

export async function authRoutes(app: FastifyInstance) {
  /** 登录页需要知道：是否开放注册（公开） */
  app.get('/api/auth/register-enabled', async () => {
    const security = await getSetting<any>('security');
    return { enabled: security.allowSelfRegister ?? false, passwordMinLength: security.passwordMinLength ?? 8 };
  });

  /** 自注册（受后台 安全设置-允许自注册 开关控制，默认关闭） */
  const registerSchema = z.object({
    name: z.string().min(1).max(50),
    email: z.string().regex(/^[^\s@]+@[^\s@]+$/, '邮箱格式不正确').optional(),
    phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确').optional(),
    password: z.string().min(8, '至少 8 位'),
  }).refine((v) => v.email || v.phone, { message: '邮箱和手机号至少填一个' });

  app.post('/api/auth/register', async (req, reply) => {
    const security = await getSetting<any>('security');
    if (!security.allowSelfRegister) {
      return reply.status(403).send({ message: '本站未开放注册，请联系管理员开通账号' });
    }
    const input = registerSchema.parse(req.body);
    // 密码长度按安全设置动态校验（zod 只兜底 8 位）
    if (input.password.length < (security.passwordMinLength ?? 8)) {
      return reply.status(400).send({ message: `密码至少 ${security.passwordMinLength ?? 8} 位` });
    }
    if (input.email) {
      const exists = await prisma.user.findUnique({ where: { email: input.email } });
      if (exists) return reply.status(409).send({ message: '邮箱已被注册' });
    }
    if (input.phone) {
      const exists = await prisma.user.findUnique({ where: { phone: input.phone } });
      if (exists) return reply.status(409).send({ message: '手机号已被注册' });
    }
    const user = await prisma.user.create({
      data: {
        name: input.name, email: input.email ?? null, phone: input.phone ?? null,
        passwordHash: await hashPassword(input.password),
        isAdmin: false,
        mustChangePassword: false, // 密码是用户自己设的，不用强制改
      },
    });
    await audit(user.id, 'user.create', `用户「${user.name}」（自助注册）`, req.ip, { email: input.email, phone: input.phone, self: true }, { type: 'user', id: user.id });
    // 注册即登录
    await createSession(reply, user.id);
    return {
      user: {
        id: user.id, name: user.name, email: user.email, phone: user.phone,
        isAdmin: user.isAdmin, mustChangePassword: user.mustChangePassword,
      },
    };
  });
  app.post('/api/auth/login', async (req, reply) => {
    const { account, password } = loginSchema.parse(req.body);
    const security = await getSetting<any>('security');
    const limit = security.loginFailLimit ?? 5;
    const lockMin = security.loginLockMinutes ?? 10;
    if (checkLocked(account, limit, lockMin)) {
      return reply.status(429).send({ message: `失败次数过多，请 ${lockMin} 分钟后再试` });
    }
    // 账号 = 邮箱或手机号
    const isPhone = /^1\d{10}$/.test(account);
    const user = isPhone
      ? await prisma.user.findUnique({ where: { phone: account } })
      : await prisma.user.findUnique({ where: { email: account } });
    const ok = user && !user.disabledAt && (await verifyPassword(user.passwordHash, password));
    if (!ok) {
      recordFailure(account, limit, lockMin);
      return reply.status(401).send({ message: '账号或密码错误' });
    }
    clearFailures(account);
    await createSession(reply, user.id);
    await audit(user.id, 'login', `用户「${user.name}」`, req.ip, undefined, { type: 'user', id: user.id });
    return {
      user: {
        id: user.id, name: user.name, email: user.email, phone: user.phone,
        isAdmin: user.isAdmin, mustChangePassword: user.mustChangePassword,
      },
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(reply, req.cookies['sid']);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = await requireAuth(req);
    return { user };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const user = await requireAuth(req);
    const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);
    const security = await getSetting<any>('security');
    if (newPassword.length < (security.passwordMinLength ?? 8)) {
      return reply.status(400).send({ message: `新密码至少 ${security.passwordMinLength ?? 8} 位` });
    }
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    if (!row || !(await verifyPassword(row.passwordHash, oldPassword))) {
      return reply.status(400).send({ message: '原密码错误' });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    await audit(user.id, 'password.change', `用户「${user.name}」`, req.ip, undefined, { type: 'user', id: user.id });
    return { ok: true };
  });
}
