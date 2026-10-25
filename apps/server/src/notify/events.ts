import type { FastifyInstance } from 'fastify';
import { Server as IOServer } from 'socket.io';
import { Client } from 'pg';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { userFromToken } from '../auth/session.js';
import { reqlog } from '../audit.js';
import { clearSettingCache, SETTINGS_NOTIFY } from '../admin/settings-service.js';

export interface BusEvent {
  type: 'comment:new' | 'comment:update' | 'asset:update' | 'version:progress' | 'version:status'
      | 'status:change' | 'notify' | 'project:update' | 'framelink:new' | 'framelink:delete';
  projectId?: string;
  [k: string]: unknown;
}

export const NOTIFY_CHANNEL = 'frametalk_events';

let io: IOServer | null = null;

export function getIo(): IOServer {
  if (!io) throw new Error('socket.io not initialized');
  return io;
}

/** API 进程内直接发事件（评论、状态等） */
export function emitEvent(evt: BusEvent) {
  try {
    if (evt.projectId) getIo().to(`project:${evt.projectId}`).emit('event', evt);
    if (typeof evt.userId === 'string') getIo().to(`user:${evt.userId}`).emit('event', evt);
  } catch (err) {
    reqlog('warn', `emitEvent failed: ${String(err)}`);
  }
}

/** Worker 进程通过 PG NOTIFY 广播事件（转码进度等），无需 socket 实例 */
export async function publishEvent(evt: BusEvent) {
  await prisma.$executeRaw`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(evt)})`;
}

export function initRealtime(app: FastifyInstance) {
  io = new IOServer(app.server, { path: '/socket.io', cors: { origin: true, credentials: true } });

  io.use(async (socket, next) => {
    const user = await userFromToken(socket.handshake.headers.cookie
      ?.split(';').map((c) => c.trim()).find((c) => c.startsWith('sid='))?.slice(4));
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string; isAdmin: boolean };
    socket.join(`user:${user.id}`);
    socket.on('join-project', async (projectId: string, ack?: (ok: boolean) => void) => {
      try {
        if (typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('bad id');
        if (!user.isAdmin) {
          const member = await prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId: user.id } },
          });
          if (!member) throw new Error('forbidden');
        }
        await socket.join(`project:${projectId}`);
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });
  });

  // API 侧 LISTEN：转发 Worker 的进度 NOTIFY + 系统设置变更（即时生效）
  const client = new Client({ connectionString: env.DATABASE_URL });
  client.on('error', (err) => reqlog('error', `pg listen error: ${String(err)}`));
  client.connect().then(async () => {
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    await client.query(`LISTEN ${SETTINGS_NOTIFY}`);
    reqlog('info', `pg LISTEN ${NOTIFY_CHANNEL} + ${SETTINGS_NOTIFY} ready`);
  }).catch((err) => reqlog('error', `pg listen connect failed: ${String(err)}`));
  client.on('notification', (msg) => {
    if (msg.channel === SETTINGS_NOTIFY) {
      clearSettingCache(msg.payload ?? undefined);
      reqlog('info', `设置已更新: ${msg.payload ?? '(全部)'}，即时生效`);
      return;
    }
    if (!msg.payload) return;
    try {
      const evt = JSON.parse(msg.payload) as BusEvent;
      emitEvent(evt);
    } catch {
      reqlog('warn', 'bad notify payload');
    }
  });

  app.addHook('onClose', async () => {
    io?.close();
    await client.end().catch(() => {});
  });
}
