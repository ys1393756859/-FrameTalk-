/**
 * 设置读写服务：DB 持久化 + 进程内缓存 + pg NOTIFY 跨进程失效（API/Worker 即时同步）。
 * 读取顺序：DB 有值（与默认值深度合并）→ 环境变量兼容（首次迁移）→ 默认值。
 */
import { prisma } from '../db.js';
import { SETTING_GROUPS, SECRET_KEEP, type SettingGroupKey } from '@frametalk/shared';

const CACHE = new Map<string, any>();
const SECRET_STORE = new Map<string, Record<string, string>>(); // group -> {key: 明文}

export const SETTINGS_NOTIFY = 'frametalk_settings_changed';

async function loadGroup(key: SettingGroupKey): Promise<any> {
  const conf = SETTING_GROUPS[key];
  const row = await prisma.settingGroup.findUnique({ where: { key } });
  const merged = { ...conf.defaults, ...(row?.data as object ?? {}) };
  // 秘密字段：DB 不回读明文（存在也不会返回），仅在保存时进 SECRET_STORE
  const secrets: Record<string, string> = {};
  for (const sk of conf.secretKeys) {
    const v = (row?.data as any)?.[sk];
    if (typeof v === 'string' && v && v !== SECRET_KEEP) secrets[sk] = v;
    delete (merged as any)[sk];
  }
  SECRET_STORE.set(key, secrets);
  return merged;
}

export async function getSetting<T = any>(key: SettingGroupKey): Promise<T> {
  if (CACHE.has(key)) return CACHE.get(key);
  const data = await loadGroup(key);
  CACHE.set(key, data);
  return data;
}

/** 实际生效的秘密值（含 DB 保存的明文）；用于存储连接 */
export function getSecret(group: SettingGroupKey, field: string): string | undefined {
  return SECRET_STORE.get(group)?.[field];
}

/** 供消费点拿"存储后端 + 连接参数"的合并视图（秘密来自 SECRET_STORE） */
export async function resolveStorageConfig() {
  const s = await getSetting<any>('storage');
  return {
    backend: s.backend as 'local' | 'webdav' | 'ftp',
    webdavBaseUrl: s.webdavBaseUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: getSecret('storage', 'webdavPassword') ?? '',
    ftpHost: s.ftpHost,
    ftpPort: s.ftpPort,
    ftpUser: s.ftpUser,
    ftpPassword: getSecret('storage', 'ftpPassword') ?? '',
    ftpSecure: s.ftpSecure,
  };
}

export async function saveSetting(
  key: SettingGroupKey,
  input: Record<string, unknown>,
  updatedBy: string,
): Promise<void> {
  const conf = SETTING_GROUPS[key];
  const current = await loadGroup(key);
  const currentSecrets = SECRET_STORE.get(key) ?? {};
  // 秘密字段：占位符/空 = 保持原值；环境变量兜底（首次在后台保存前）
  const merged = { ...current, ...input };
  const toStore: Record<string, unknown> = { ...merged };
  for (const sk of conf.secretKeys) {
    const incoming = input[sk];
    if (incoming === undefined || incoming === '' || incoming === SECRET_KEEP) {
      toStore[sk] = currentSecrets[sk] ?? envFallbackSecret(key, sk);
    } else {
      toStore[sk] = String(incoming);
    }
  }
  // 全量校验（数字字段 coerce）
  const parsed = conf.schema.parse(toStore);
  await prisma.settingGroup.upsert({
    where: { key },
    create: { key, data: parsed as any, updatedBy },
    update: { data: parsed as any, updatedBy },
  });
  CACHE.delete(key);
  await prisma.$executeRawUnsafe(`SELECT pg_notify('${SETTINGS_NOTIFY}', '${key}')`);
}

export function clearSettingCache(key?: string) {
  if (key) CACHE.delete(key);
  else CACHE.clear();
  if (key) SECRET_STORE.delete(key);
  else SECRET_STORE.clear();
}

/** 首次使用后台前，兼容 .env 里的存储配置作为初始秘密值 */
function envFallbackSecret(group: string, field: string): string {
  if (group === 'storage' && field === 'webdavPassword') return process.env.WEBDAV_PASSWORD ?? '';
  if (group === 'storage' && field === 'ftpPassword') return process.env.FTP_PASSWORD ?? '';
  return '';
}

/** 回读给前端的视图：秘密字段 -> 是否已设置 */
export function publicView(key: SettingGroupKey): any {
  const data = CACHE.get(key) ?? {};
  const conf = SETTING_GROUPS[key];
  const out: any = { ...data };
  const secrets = SECRET_STORE.get(key) ?? {};
  for (const sk of conf.secretKeys) {
    out[sk] = secrets[sk] ? SECRET_KEEP : '';
    out[`${sk}Set`] = !!secrets[sk];
  }
  return out;
}
