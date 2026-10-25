import PgBoss from 'pg-boss';
import { env } from './env.js';

export const QUEUE_TRANSCODE = 'transcode';
export const QUEUE_MAINTENANCE = 'maintenance';

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({ connectionString: env.DATABASE_URL });
    boss.on('error', (err) => console.error(`[pg-boss] ${String(err)}`));
    await boss.start();
    // v10：schedule/send 前队列必须存在（幂等）
    await boss.createQueue(QUEUE_TRANSCODE);
    await boss.createQueue(QUEUE_MAINTENANCE);
  }
  return boss;
}

export async function enqueueTranscode(versionId: string, delaySeconds = 0) {
  const b = await getBoss();
  await b.send({
    name: QUEUE_TRANSCODE,
    data: { versionId },
    ...(delaySeconds > 0 ? { startAfter: new Date(Date.now() + delaySeconds * 1000) } : {}),
  });
}

/** 幂等注册定时任务（Worker 启动时调用） */
export async function registerSchedules() {
  const b = await getBoss();
  await b.schedule(QUEUE_MAINTENANCE, '17 * * * *', { kind: 'hourly' }); // 每小时：清 tmp
  await b.schedule(QUEUE_MAINTENANCE, '30 3 * * *', { kind: 'daily' }); // 每天：清回收站
}
