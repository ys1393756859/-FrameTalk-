/**
 * 原片归档存储后端：local / webdav / ftp。
 * 配置来源：后台"系统设置"（DB，即时生效），.env 仅作首次兜底。
 * 设计：代理、封面、雪碧图、波形始终留本地（播放与 Range 性能）；
 * 仅「原片 originals/」在转码完成后归档远端，下载/重试转码时按需回源。
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mediaDir } from './env.js';
import { ensureDir } from './util.js';
import { reqlog } from './audit.js';
import { resolveStorageConfig } from './admin/settings-service.js';

export type StorageBackend = 'local' | 'webdav' | 'ftp';

/** 当前后端（读后台设置） */
export async function backend(): Promise<StorageBackend> {
  const cfg = await resolveStorageConfig();
  return cfg.backend;
}

export async function backendLabel(): Promise<string> {
  const cfg = await resolveStorageConfig();
  if (cfg.backend === 'webdav') return `webdav: ${cfg.webdavBaseUrl}`;
  if (cfg.backend === 'ftp') return `ftp: ${cfg.ftpHost}:${cfg.ftpPort}`;
  return 'local（本机媒体盘）';
}

type Cfg = Awaited<ReturnType<typeof resolveStorageConfig>>;

/* ---------------- WebDAV（HTTP，fetch 直连） ---------------- */

function davUrl(cfg: Cfg, remoteRel: string): string {
  const base = cfg.webdavBaseUrl.replace(/\/+$/, '');
  return `${base}/${remoteRel.split('/').map(encodeURIComponent).join('/')}`;
}

function davHeaders(cfg: Cfg, extra: Record<string, string> = {}): Record<string, string> {
  const auth = Buffer.from(`${cfg.webdavUsername}:${cfg.webdavPassword}`).toString('base64');
  return { authorization: `Basic ${auth}`, ...extra };
}

async function davMkcol(cfg: Cfg, dirRel: string): Promise<void> {
  const parts = dirRel.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += `${p}/`;
    await fetch(davUrl(cfg, cur), { method: 'MKCOL', headers: davHeaders(cfg) })
      .then((r) => r.body?.cancel?.()).catch(() => {});
  }
}

/* ---------------- FTP（basic-ftp，惰性加载） ---------------- */

async function ftpClient(cfg: Cfg) {
  const mod = await import('basic-ftp');
  const client = new mod.Client(15_000);
  await client.access({
    host: cfg.ftpHost || '127.0.0.1',
    port: cfg.ftpPort || 21,
    user: cfg.ftpUser || 'anonymous',
    password: cfg.ftpPassword || '',
    secure: cfg.ftpSecure,
  });
  return client;
}

/** 在远端目录上下文中执行操作（结束后关闭连接） */
async function ftpInDir<T>(cfg: Cfg, dirRel: string, fn: (client: any) => Promise<T>): Promise<T> {
  const client = await ftpClient(cfg);
  try {
    // basic-ftp 的 ensureDir 会逐级创建并把工作目录切到该路径
    await client.ensureDir(dirRel);
    return await fn(client);
  } finally {
    client.close();
  }
}

/* ---------------- 统一接口 ---------------- */

export interface Storage {
  /** 上传本地文件到远端 */
  put(localAbs: string, remoteRel: string): Promise<void>;
  /** 远端文件下载到本地路径 */
  get(remoteRel: string, localAbs: string): Promise<void>;
  /** 以 Node 流返回远端文件（webdav 零落盘；ftp 先落临时文件） */
  stream(remoteRel: string): Promise<{ stream: Readable; size?: number }>;
  delete(remoteRel: string): Promise<void>;
}

function makeStorage(cfg: Cfg): Storage {
  if (cfg.backend === 'webdav') {
    return {
      async put(localAbs, remoteRel) {
        await davMkcol(cfg, path.posix.dirname(remoteRel));
        const body = await fsp.readFile(localAbs);
        const res = await fetch(davUrl(cfg, remoteRel), {
          method: 'PUT',
          headers: davHeaders(cfg, { 'content-type': 'application/octet-stream', overwrite: 'T' }),
          body: new Uint8Array(body),
        });
        if (!res.ok) throw new Error(`WebDAV PUT 失败 ${res.status}: ${remoteRel}`);
      },
      async get(remoteRel, localAbs) {
        const res = await fetch(davUrl(cfg, remoteRel), { headers: davHeaders(cfg) });
        if (!res.ok) throw new Error(`WebDAV GET 失败 ${res.status}: ${remoteRel}`);
        await ensureDir(path.dirname(localAbs));
        await fsp.writeFile(localAbs, Buffer.from(await res.arrayBuffer()));
      },
      async stream(remoteRel) {
        const res = await fetch(davUrl(cfg, remoteRel), { headers: davHeaders(cfg) });
        if (!res.ok || !res.body) throw new Error(`WebDAV GET 失败 ${res.status}: ${remoteRel}`);
        const size = res.headers.get('content-length');
        return { stream: Readable.fromWeb(res.body as any), size: size ? Number(size) : undefined };
      },
      async delete(remoteRel) {
        await fetch(davUrl(cfg, remoteRel), { method: 'DELETE', headers: davHeaders(cfg) })
          .then((r) => r.body?.cancel?.()).catch(() => {});
      },
    };
  }
  if (cfg.backend === 'ftp') {
    return {
      async put(localAbs, remoteRel) {
        const name = path.posix.basename(remoteRel);
        await ftpInDir(cfg, path.posix.dirname(remoteRel), (client) => client.uploadFrom(localAbs, name));
      },
      async get(remoteRel, localAbs) {
        const name = path.posix.basename(remoteRel);
        await ensureDir(path.dirname(localAbs));
        await ftpInDir(cfg, path.posix.dirname(remoteRel), (client) => client.downloadTo(localAbs, name));
      },
      async stream(remoteRel) {
        const tmp = path.join(mediaDir(), 'tmp', `fetch-${Date.now()}-${path.basename(remoteRel)}`);
        await this.get(remoteRel, tmp);
        const st = await fsp.stat(tmp);
        return { stream: fs.createReadStream(tmp, { autoClose: true }), size: st.size };
      },
      async delete(remoteRel) {
        const name = path.posix.basename(remoteRel);
        await ftpInDir(cfg, path.posix.dirname(remoteRel), (client) => client.remove(name).catch(() => {}));
      },
    };
  }
  return {
    async put() { /* 本地后端：文件已就位 */ },
    async get() { /* 本地后端：无需回源 */ },
    async stream(remoteRel) {
      const abs = path.join(mediaDir(), remoteRel);
      const st = await fsp.stat(abs);
      return { stream: fs.createReadStream(abs), size: st.size };
    },
    async delete() {},
  };
}

export async function storage(): Promise<Storage> {
  return makeStorage(await resolveStorageConfig());
}

/** 本地是否存在该相对路径文件 */
export async function localExists(remoteRel: string): Promise<boolean> {
  try {
    await fsp.access(path.join(mediaDir(), remoteRel));
    return true;
  } catch {
    return false;
  }
}

/**
 * 原片归档：上传到远端后删除本地副本（renditions 不动）。
 * local 后端为空操作。
 */
export async function archiveOriginalIfNeeded(localAbs: string, remoteRel: string): Promise<void> {
  const cfg = await resolveStorageConfig();
  if (cfg.backend === 'local') return;
  try {
    await makeStorage(cfg).put(localAbs, remoteRel);
    await fsp.rm(path.dirname(localAbs), { recursive: true, force: true });
    reqlog('info', `[storage] 原片已归档到 ${cfg.backend}: ${remoteRel}`);
  } catch (err) {
    // 归档失败不阻塞：保留本地文件，下次重试/管理员处理
    reqlog('error', `[storage] 归档失败（保留本地副本）: ${String(err)}`);
  }
}

/** 确保原片在本地（远端回源到原位置）；返回本地绝对路径 */
export async function ensureLocal(remoteRel: string): Promise<string> {
  const abs = path.join(mediaDir(), remoteRel);
  if (await localExists(remoteRel)) return abs;
  const cfg = await resolveStorageConfig();
  if (cfg.backend === 'local') throw new Error(`文件不存在: ${remoteRel}`);
  await makeStorage(cfg).get(remoteRel, abs);
  return abs;
}
