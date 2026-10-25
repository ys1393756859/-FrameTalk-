import type { FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { userFromToken } from './session.js';
import { roleAtLeast, type ProjectRole, type SessionUser } from '@frametalk/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function attachUser(req: FastifyRequest) {
  req.user = await userFromToken(req.cookies['sid']) ?? undefined;
}

/** 要求已登录，否则 401 */
export async function requireAuth(req: FastifyRequest): Promise<SessionUser> {
  if (!req.user) throw httpError(401, '未登录');
  return req.user;
}

/** 要求系统管理员，否则 403 */
export async function requireAdmin(req: FastifyRequest): Promise<SessionUser> {
  const user = await requireAuth(req);
  if (!user.isAdmin) throw httpError(403, '需要管理员权限');
  return user;
}

/**
 * 要求用户在指定项目上具备最低项目角色；系统管理员直接放行（视同管理者）。
 * 返回该用户在此项目中的有效角色。
 */
export async function requireProjectRole(
  user: SessionUser,
  projectId: string,
  required: ProjectRole,
): Promise<ProjectRole | 'admin'> {
  if (user.isAdmin) return 'admin';
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });
  const role = (member?.role as ProjectRole | undefined) ?? null;
  if (!role || !roleAtLeast(role, required)) throw httpError(403, '没有该项目权限');
  return role;
}

/** 项目成员（任意角色即可访问，如媒体播放） */
export function requireMember(user: SessionUser, projectId: string) {
  return requireProjectRole(user, projectId, 'viewer');
}

export function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
