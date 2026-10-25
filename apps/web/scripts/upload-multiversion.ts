/**
 * 多版本联调脚本：登录 → 建项目 → 手动 tus 上传 3 个真实视频为同一资产的 v1/v2/v3 → 轮询转码
 * 运行：cd apps/web && npx tsx scripts/upload-multiversion.ts
 * 零依赖实现 tus 1.0.0（POST 创建 + PATCH 分片），完成响应带 x-asset-id / x-version-id
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3000';
const VIDEOS = [
  'C:/Users/13937/Videos/5月24日-1.mp4',
  'C:/Users/13937/Videos/6月11日.mp4',
  'C:/Users/13937/Videos/6月11日(1).mp4',
];
const CHUNK = 8 * 1024 * 1024;

let cookie = '';

async function api(method: string, url: string, body?: any) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function tusUpload(file: string, metadata: Record<string, string>) {
  const size = fs.statSync(file).size;
  const metaHeader = Object.entries(metadata)
    .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join(',');
  const createRes = await fetch(BASE + '/api/uploads', {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': metaHeader,
      cookie,
    },
  });
  if (createRes.status !== 201) {
    throw new Error('tus 创建失败 ' + createRes.status + ' ' + (await createRes.text()).slice(0, 200));
  }
  const loc = createRes.headers.get('location')!;
  const url = loc.startsWith('http') ? loc : BASE + loc;

  const fd = fs.openSync(file, 'r');
  let offset = 0;
  let lastHeaders = createRes.headers;
  try {
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const r = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
          cookie,
        },
        body: new Uint8Array(buf),
      });
      if (r.status !== 204) {
        throw new Error(`tus PATCH @${offset} 失败 ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      offset = Number(r.headers.get('upload-offset') ?? offset + len);
      lastHeaders = r.headers;
      process.stdout.write(`\r  ${(offset / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)} MB`);
    }
  } finally {
    fs.closeSync(fd);
  }
  console.log('');
  return {
    assetId: lastHeaders.get('x-asset-id') ?? undefined,
    versionId: lastHeaders.get('x-version-id') ?? undefined,
  };
}

async function main() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin@local', password: '123456789' }),
  });
  if (!r.ok) throw new Error('登录失败 ' + r.status);
  cookie = (r.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log('登录成功');

  const name = '联调多版本-' + Date.now().toString(36);
  const proj = await api('POST', '/api/projects', { name });
  console.log('项目:', name, proj.id);

  let assetId = '';
  for (let i = 0; i < VIDEOS.length; i++) {
    const file = VIDEOS[i]!;
    const meta: Record<string, string> = {
      filename: path.basename(file),
      filetype: 'video/mp4',
      projectId: proj.id,
    };
    if (assetId) meta.assetId = assetId;
    console.log(`上传 v${i + 1}: ${path.basename(file)}`);
    const res = await tusUpload(file, meta);
    if (!assetId && res.assetId) assetId = res.assetId;
    console.log(`  -> assetId=${res.assetId ?? assetId} versionId=${res.versionId}`);
  }

  const t0 = Date.now();
  const TIMEOUT = 30 * 60 * 1000;
  while (Date.now() - t0 < TIMEOUT) {
    const { versions } = await api('GET', `/api/assets/${assetId}`);
    const stat = versions.map((v: any) => `v${v.versionNo}:${v.status}(${v.progress ?? 0}%)`).join(' ');
    process.stdout.write(`\r[${Math.round((Date.now() - t0) / 1000)}s] ${stat}        `);
    const done =
      versions.length >= VIDEOS.length &&
      versions.every((v: any) => ['ready', 'failed', 'unsupported'].includes(v.status));
    if (done) {
      console.log('\n=== 转码结束 ===');
      console.log(
        JSON.stringify(
          {
            projectId: proj.id,
            projectName: name,
            assetId,
            versions: versions.map((v: any) => ({
              id: v.id,
              no: v.versionNo,
              status: v.status,
              fps: v.fps,
              frames: v.frameCount,
              duration: v.duration,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('转码超时（30 分钟）');
}

main().catch((e) => {
  console.error('\n失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
