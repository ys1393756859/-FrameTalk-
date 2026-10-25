#!/usr/bin/env node
/**
 * 飞书通知端到端冒烟：飞书开放平台桩（8800）+ 独立 API 实例（8902，不动正在跑的 3000 实例）。
 * 服务端直连飞书（FEISHU_BASE_URL 指向桩），无需外部中转。验证双通道投递：
 * 顶层评论 = 群卡片 @ 成员 + 逐人私信；线程回复 = 仅私信（@谁私信谁，不进群）；
 * 以及后台设置组读写/脱敏、测试按钮、显式@提及立即发送、聚合窗口合并、每日上限、免打扰推迟与补发。
 * 用法：node scripts/feishu-smoke.mjs（需 fsmz-pg 容器在跑；管理员 admin@local/123456789）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'apps/server');
const STUB_LOG = path.join(ROOT, 'data/feishu-stub.jsonl');
const BASE = 'http://127.0.0.1:8902';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://fsmz:fsmz@localhost:5433/fsmz';
const PID = {
  project: '22222222-2222-2222-2222-222222222201',
  asset: '33333333-3333-3333-3333-333333333301',
  version: '44444444-4444-4444-4444-444444444401',
  u1: '11111111-1111-1111-1111-111111111101', // 有手机号
  u2: '11111111-1111-1111-1111-111111111102', // 有手机号
  u3: '11111111-1111-1111-1111-111111111103', // 无手机号有邮箱
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    // 无 body 的请求不能带 Content-Type: application/json（Fastify 会 400）
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith('sid=')) cookie = c.split(';')[0];
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}
const stubCalls = () => fs.existsSync(STUB_LOG)
  ? fs.readFileSync(STUB_LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
// 双通道分计：群消息 receive_id = oc_test；私信 receive_id = ou_ 开头（open_id）
const groupCalls = () => stubCalls().filter((c) => c.receive_id === 'oc_test');
const dmCalls = () => stubCalls().filter((c) => String(c.receive_id ?? '').startsWith('ou_'));
async function waitForCount(getter, count, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (getter().length >= count) return;
    await sleep(1000);
  }
  throw new Error(`超时等待「${desc}」：期望 >=${count} 个，实际 ${getter().length}`);
}
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'fsmz-pg', 'psql', '-U', 'fsmz', '-d', 'fsmz', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`psql 失败: ${r.stderr || r.stdout}`);
  return r.stdout;
}
// 冒烟与常驻实例共享同一个库：开场快照真实 feishu 配置，finally 原样恢复（含密钥），
// 并 pg_notify 让常驻进程失效缓存——绝不把桩配置/关闭状态留在库里。
function snapshotFeishuSetting() {
  const r = spawnSync('docker', ['exec', '-i', 'fsmz-pg', 'psql', '-U', 'fsmz', '-d', 'fsmz', '-t', '-A',
    '-c', `SELECT data FROM "SettingGroup" WHERE key='feishu'`], { encoding: 'utf-8' });
  const out = (r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}
function restoreFeishuSetting(json) {
  const escaped = json.replace(/'/g, "''");
  psql(`UPDATE "SettingGroup" SET data='${escaped}'::jsonb WHERE key='feishu'; SELECT pg_notify('frametalk_settings_changed','feishu');`);
}

const SEED_SQL = `SET client_encoding TO 'UTF8';
INSERT INTO "User" (id,name,email,phone,"passwordHash","isAdmin","mustChangePassword","createdAt","updatedAt") VALUES
 ('${PID.u1}','飞书测试甲','fs_a@test.local','13800000001',(SELECT "passwordHash" FROM "User" WHERE email='admin@local'),false,false,now(),now()),
 ('${PID.u2}','飞书测试乙','fs_b@test.local','13800000002',(SELECT "passwordHash" FROM "User" WHERE email='admin@local'),false,false,now(),now()),
 ('${PID.u3}','飞书测试丙','fs_c@test.local',NULL,(SELECT "passwordHash" FROM "User" WHERE email='admin@local'),false,false,now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO "Project" (id,name,kind,"createdAt","updatedAt") VALUES ('${PID.project}','飞书通知冒烟','self',now(),now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "ProjectMember" ("projectId","userId",role,"createdAt") VALUES
 ('${PID.project}','${PID.u1}','reviewer',now()),
 ('${PID.project}','${PID.u2}','reviewer',now()),
 ('${PID.project}','${PID.u3}','reviewer',now())
ON CONFLICT ("projectId","userId") DO NOTHING;
INSERT INTO "Asset" (id,"projectId",name,kind,"reviewStatus","createdAt","updatedAt") VALUES
 ('${PID.asset}','${PID.project}','冒烟视频','video','pending',now(),now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "AssetVersion" (id,"assetId","versionNo","originalName","filePath",size,mime,status,progress,"frameCount","createdAt","updatedAt") VALUES
 ('${PID.version}','${PID.asset}',1,'smoke.mp4','originals/smoke/smoke.mp4',0,'video/mp4','ready',100,1000,now(),now()) ON CONFLICT (id) DO NOTHING;`;

const CLEAN_SQL = `SET client_encoding TO 'UTF8';
DELETE FROM "Project" WHERE id='${PID.project}';
DELETE FROM "User" WHERE id IN ('${PID.u1}','${PID.u2}','${PID.u3}');`;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const postComment = (body) => api('POST', `/api/versions/${PID.version}/comments`, body);
// 群/私信计数快照（「不变」断言用：先记数、等待、再比对）
const counts = () => ({ g: groupCalls().length, d: dmCalls().length });

// ---- 启动桩 + 独立 API 实例 ----
fs.rmSync(STUB_LOG, { force: true });
const stub = spawn(process.execPath, [path.join(ROOT, 'scripts/feishu-stub.mjs')], { stdio: 'inherit' });
const apiProc = spawn('npx', ['tsx', 'src/api.ts'], {
  cwd: SERVER_DIR, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DATABASE_URL, MEDIA_DIR: path.join(ROOT, 'data', 'media'), PORT: '8902', HOST: '127.0.0.1', MIGRATE_ON_BOOT: '0', FEISHU_BASE_URL: 'http://127.0.0.1:8800/open-apis' },
});
const kill = (p) => { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* ignore */ } };
apiProc.stdout.on('data', (d) => process.stdout.write('[api] ' + d));
apiProc.stderr.on('data', (d) => process.stderr.write('[api:err] ' + d));

async function waitApiUp() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/api/auth/me`); if (r.status) return; } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('API 实例（8902）启动超时');
}

const realCfg = snapshotFeishuSetting();
console.log(realCfg ? '[snapshot] 已快照真实 feishu 配置（结束后原样恢复）' : '[snapshot] 库中无 feishu 配置行（结束后删除冒烟写入）');
try {
  psql(SEED_SQL);
  console.log('[seed] 测试项目/成员/资产已就绪');
  await waitApiUp();

  // 1) 登录 + 设置组默认值
  const login = await api('POST', '/api/auth/login', { account: 'admin@local', password: '123456789' });
  check('管理员登录', login.status === 200 && !!cookie, `HTTP ${login.status}`);
  const g1 = await api('GET', '/api/admin/settings');
  check('后台出现「飞书通知」设置组', !!g1.data?.groups?.feishu && g1.data?.labels?.feishu === '飞书通知');

  // 2) 保存配置 + 秘密脱敏
  const put = await api('PUT', '/api/admin/settings/feishu', {
    enabled: true, appId: 'cli_stub', appSecret: 'secret_stub', chatId: 'oc_test',
    windowMinutes: 1, dailyMax: 0, quietStart: '', quietEnd: '', mentionBypass: true, atAuthor: false,
    platformUrl: 'http://127.0.0.1:3000',
  });
  check('保存飞书配置（即时生效）', put.status === 200 && put.data?.ok === true, put.data?.message ?? '');
  const g2 = await api('GET', '/api/admin/settings');
  check('appSecret 回读打码', g2.data?.groups?.feishu?.appSecret === '__KEEP__' && g2.data?.groups?.feishu?.appSecretSet === true);

  // 3) 测试按钮：校验凭证 + 测试卡片（只进群、不 @ 人、不私信）
  const t = await api('POST', '/api/admin/settings/feishu/test');
  check('测试按钮返回成功', t.data?.ok === true, t.data?.message ?? '');
  await sleep(300);
  const call1 = groupCalls()[0];
  check('测试消息=群卡片不@人不私信',
    groupCalls().length === 1 && dmCalls().length === 0
    && call1?.msg_type === 'interactive' && call1?.text.includes('测试消息') && !call1?.text.includes('<at '),
    call1?.text ?? '');

  // 4) 显式 @提及 顶层评论 → 绕过窗口立即「群卡片 + 逐人私信」
  const c1 = await postComment({ frameIn: 10, body: '紧急：画面闪烁需要重新修改', mentions: [PID.u2] });
  check('创建@提及评论', c1.status === 200 && !!c1.data?.comment?.id, c1.data?.message ?? '');
  await waitForCount(dmCalls, 3, 20_000, '@提及评论立即双通道投递');
  check('@评论后：群 2 条 + 私信 3 条（成员甲/乙/丙各一条）',
    groupCalls().length === 2 && dmCalls().length === 3,
    `群 ${groupCalls().length} / 私信 ${dmCalls().length}`);

  const call2 = groupCalls()[1];
  const card2 = JSON.parse(call2.text);
  const cardEls = card2.elements ?? [];
  // 卡片里 @ 标签在 markdown content 中（JSON 解析后才是 <at id="ou_x"></at> 原文）
  const atIds = cardEls.flatMap((e) => e.tag === 'markdown'
    ? [...(e.content ?? '').matchAll(/<at id="([^"]+)"><\/at>/g)].map((m) => m[1]) : []);
  check('群卡片@名单=全体成员−评论作者（2 手机 + 1 邮箱降级 → 3 open_id）',
    atIds.length === 3 && atIds.includes('ou_m_13800000001') && atIds.includes('ou_m_13800000002') && atIds.includes('ou_e_fs_c@test.local'),
    JSON.stringify(atIds));
  check('群卡片：标题含项目名+集数、markdown 含 @ 与帧号、带深链按钮',
    call2.msg_type === 'interactive'
    && (card2.header?.title?.content ?? '').includes('飞书通知冒烟 · 冒烟视频')
    && cardEls.some((e) => e.tag === 'markdown' && (e.content ?? '').includes('<at id="ou_m_13800000001"></at>'))
    && cardEls.some((e) => e.tag === 'markdown' && (e.content ?? '').includes('帧 10'))
    && cardEls.some((e) => e.tag === 'action' && (e.actions?.[0]?.url ?? '').includes('/p/')),
    card2.header?.title?.content ?? '');
  check('群卡片内容含项目名/素材/帧号/正文', ['飞书通知冒烟', '冒烟视频', '帧 10', '画面闪烁'].every((s) => call2.text.includes(s)), card2.header?.title?.content ?? '');

  const dms = dmCalls();
  const dmIds = dms.map((c) => c.receive_id).sort();
  const dmCards = dms.map((c) => { try { return JSON.parse(c.text); } catch { return null; } });
  check('私信=3 张卡片发给 3 个 open_id，标题「与你相关」，不含 <at>',
    dms.every((c) => c.msg_type === 'interactive')
    && JSON.stringify(dmIds) === JSON.stringify(['ou_e_fs_c@test.local', 'ou_m_13800000001', 'ou_m_13800000002'].sort())
    && dmCards.every((c) => (c?.header?.title?.content ?? '').includes('条评论与你相关'))
    && dms.every((c) => !c.text.includes('<at ')),
    JSON.stringify(dmIds));
  check('私信卡片含评论正文与帧号', dmCards.every((c) => (c.elements ?? []).some((e) => e.tag === 'markdown' && (e.content ?? '').includes('帧 10'))));

  // 5) 普通顶层评论 → 聚合窗口内合并成一批（群 1 + 私信 3）
  const before5 = counts();
  await postComment({ frameIn: 20, body: '普通评论A' });
  await postComment({ frameIn: 30, body: '普通评论B' });
  await sleep(6_000);
  check('窗口内不发送（6 秒后计数不变）', counts().g === before5.g && counts().d === before5.d, `群 ${counts().g} / 私信 ${counts().d}`);
  await waitForCount(groupCalls, before5.g + 1, 85_000, '聚合窗口到期发送群摘要');
  await waitForCount(dmCalls, before5.d + 3, 20_000, '聚合窗口到期逐人私信');
  const call3 = groupCalls()[before5.g];
  check('两条评论合并为一批（群摘要含 A/B）', call3.text.includes('2 条评论') && call3.text.includes('普通评论A') && call3.text.includes('普通评论B'));

  // 6) 每日上限：当天已发 2 批，上限设为 1 → 新摘要直接丢弃
  // 把 lastSentAt 拨回 60s，避开 urgent 30s 最小间隔把 flush 推迟到断言窗口外，确保立即走到 dailyMax 检查（丢弃才真实）
  const before6 = counts();
  psql(`UPDATE "FeishuNotifyBuffer" SET "lastSentAt"=now() - interval '60 seconds' WHERE "projectId"='${PID.project}';`);
  await api('PUT', '/api/admin/settings/feishu', { dailyMax: 1 });
  await postComment({ frameIn: 40, body: '限流期评论', mentions: [PID.u2] });
  await sleep(8_000);
  check('达到每日上限后群/私信都不再发送', counts().g === before6.g && counts().d === before6.d, `群 ${counts().g} / 私信 ${counts().d}`);
  await api('PUT', '/api/admin/settings/feishu', { dailyMax: 0 });

  // 7) 免打扰：覆盖当前时刻 → 推迟不发；解除后（拨快 dueAt 模拟免打扰结束）补发
  const before7 = counts();
  const h = new Date().getHours();
  const hh = (x) => `${String(((x % 24) + 24) % 24).padStart(2, '0')}:00`;
  await api('PUT', '/api/admin/settings/feishu', { quietStart: hh(h - 1), quietEnd: hh(h + 1) });
  await postComment({ frameIn: 50, body: '免打扰期评论', mentions: [PID.u2] });
  await sleep(8_000);
  check('免打扰期间不发送', counts().g === before7.g && counts().d === before7.d, `群 ${counts().g} / 私信 ${counts().d}`);
  await api('PUT', '/api/admin/settings/feishu', { quietStart: '', quietEnd: '' });
  psql(`UPDATE "FeishuNotifyBuffer" SET "dueAt"=now() WHERE "projectId"='${PID.project}';`); // 模拟免打扰结束
  await waitForCount(groupCalls, before7.g + 1, 45_000, '免打扰结束后补发群摘要');
  await waitForCount(dmCalls, before7.d + 3, 20_000, '免打扰补发批的逐人私信全部落盘'); // 防竞态：回复场景的计数基线必须等补发私信发完
  check('免打扰缓冲已补发', groupCalls()[before7.g].text.includes('免打扰期评论'));

  // 8) 线程回复（admin 回复自己的根评论并 @乙）→ 仅私信被 @ 者，不进群、不私信无关成员
  const before8 = counts();
  const r1 = await postComment({ parentId: c1.data.comment.id, frameIn: 10, body: '回复：已确认需要改', mentions: [PID.u2] });
  check('创建线程回复', r1.status === 200 && !!r1.data?.comment?.id, r1.data?.message ?? '');
  await waitForCount(dmCalls, before8.d + 1, 50_000, '回复立即私信（绕过聚合窗口，受 30s 最小间隔约束）');
  await sleep(3_000); // 给可能的误发群消息留观察窗
  check('回复仅私信@的人：私信 +1、群不变', counts().g === before8.g && counts().d === before8.d + 1, `群 ${counts().g} / 私信 ${counts().d}`);
  const dmReply = dmCalls()[dmCalls().length - 1];
  const dmReplyCard = JSON.parse(dmReply.text);
  check('回复私信直达被@者（乙），卡片带「·回复」标记与「与你相关」标题',
    dmReply.receive_id === 'ou_m_13800000002'
    && (dmReplyCard.header?.title?.content ?? '').includes('与你相关')
    && (dmReplyCard.elements ?? []).some((e) => e.tag === 'markdown' && (e.content ?? '').includes('·回复')),
    dmReplyCard.header?.title?.content ?? '');
} catch (err) {
  console.error('\n✘ 冒烟中断:', err.message);
  process.exitCode = 1;
} finally {
  // 清理：恢复真实 feishu 配置（快照原样写回 + pg_notify 让常驻实例失效缓存）、删测试数据、杀子进程
  try {
    if (realCfg) restoreFeishuSetting(realCfg);
    else psql(`DELETE FROM "SettingGroup" WHERE key='feishu'; SELECT pg_notify('frametalk_settings_changed','feishu');`);
    console.log('[restore] feishu 配置已恢复为冒烟前状态');
  } catch (e) { console.error('[restore] 失败（请手动检查后台飞书配置）:', e.message); }
  try { psql(CLEAN_SQL); console.log('[clean] 测试项目/用户已删除'); } catch (e) { console.error('[clean] 失败:', e.message); }
  kill(stub); kill(apiProc);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 冒烟结果: ${pass}/${results.length} 通过 =====`);
  process.exit(process.exitCode ?? 0);
}
