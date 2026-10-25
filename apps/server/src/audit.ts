import { prisma } from './db.js';

/** 机器可读引用：target 只用于展示，统计/反查一律走 type+id */
export interface AuditRef {
  type: string; // project | version | asset | user | comment | framelink | group
  id: string;
}

export async function audit(
  actorId: string | null,
  action: string,
  target: string,
  ip?: string,
  meta?: Record<string, unknown>,
  ref?: AuditRef,
) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId, action, target, ip: ip ?? null,
        targetType: ref?.type ?? null, targetId: ref?.id ?? null,
        meta: (meta ?? undefined) as any,
      },
    });
  } catch (err) {
    reqlog('error', `audit write failed: ${String(err)}`);
  }
}

/** 轻量日志：没有 fastify 上下文时使用 */
export function reqlog(level: 'info' | 'warn' | 'error', msg: string) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}
