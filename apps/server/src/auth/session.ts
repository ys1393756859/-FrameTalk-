import type { FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { randomToken, sha256 } from '../util.js';
import type { SessionUser } from '@frametalk/shared';
import { getSetting } from '../admin/settings-service.js';

const COOKIE = 'sid';

export async function createSession(reply: FastifyReply, userId: string) {
  const security = await getSetting<any>('security');
  const maxAgeSec = (security.sessionDays ?? 7) * 24 * 3600;
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + maxAgeSec * 1000);
  await prisma.session.create({ data: { id: sha256(token), userId, expiresAt } });
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
}

export async function destroySession(reply: FastifyReply, token?: string) {
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function destroyUserSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

/** 由 cookie token 取用户；过期/禁用返回 null */
export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  if (session.user.disabledAt) return null;
  const u = session.user;
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword };
}
