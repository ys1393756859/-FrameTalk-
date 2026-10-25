/**
 * 回复链路回归冒烟（API 级，自清理）。
 * 前置：3000 端口 server 已起；库中存在「第02集-测试」资产（若 DB 重建后 id 变化，改下面 VERSION 常量）。
 * 用法：node apps/server/scripts/reply-smoke.mjs
 */
const BASE = 'http://localhost:3000';
let cookie = '';
let pass = 0, fail = 0;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) cookie = c.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const projects = await req('GET', '/api/projects');
// 登录
const login = await req('POST', '/api/auth/login', { account: 'admin@local', password: '123456789' });
check('登录', login.status === 200, JSON.stringify(login.json)?.slice(0, 120));

// 测试剧集「第02集-测试」最新版（ready，frameCount=50）
const target = {
  assetId: 'af0d80e4-5f06-4e08-9bce-33868bc753f4',
  versionId: '2ca9df7d-78c4-4c26-9f68-bf1f93ffdd7c',
  frameCount: 50,
};
console.log('  目标:', target.assetId, target.versionId, 'frameCount', target.frameCount);

const longBody = '这是一条很长的批注用于验证折叠展示。'.repeat(30) + '\n第二行内容\n第三行内容';

// 1. 楼主评论
const root = await req('POST', `/api/versions/${target.versionId}/comments`, { frameIn: 10, body: longBody });
check('发楼主评论', root.status === 200 && !!root.json?.comment?.id, JSON.stringify(root.json)?.slice(0, 200));
const rootId = root.json?.comment?.id;

// 2. 回复楼主：不带 frameIn，应继承 10
const r1 = await req('POST', `/api/versions/${target.versionId}/comments`, { parentId: rootId, body: '回复楼主：同意，下一版修正' });
check('回复楼主(省略frameIn)', r1.status === 200 && r1.json?.comment?.frameIn === 10 && r1.json?.comment?.parentId === rootId,
  JSON.stringify(r1.json)?.slice(0, 200));
const r1Id = r1.json?.comment?.id;

// 3. 回复楼层（对回复再回复）
const r2 = await req('POST', `/api/versions/${target.versionId}/comments`, { parentId: r1Id, body: '回复二楼：已记录' });
check('回复楼层(链式)', r2.status === 200 && r2.json?.comment?.parentId === r1Id && r2.json?.comment?.frameIn === 10,
  JSON.stringify(r2.json)?.slice(0, 200));

// 4. 空回复应 400
const empty = await req('POST', `/api/versions/${target.versionId}/comments`, { parentId: rootId });
check('空回复拒绝', empty.status === 400 && (empty.json?.message ?? '').includes('回复需要'), JSON.stringify(empty.json)?.slice(0, 160));

// 5. 不存在的 parent 应 400
const badParent = await req('POST', `/api/versions/${target.versionId}/comments`, { parentId: '00000000-0000-4000-8000-000000000000', body: 'x' });
check('无效parent拒绝', badParent.status === 400 && (badParent.json?.message ?? '').includes('不存在'), JSON.stringify(badParent.json)?.slice(0, 160));

// 6. 无 frameIn 且无 parentId 应 400（zod refine）
const noFrame = await req('POST', `/api/versions/${target.versionId}/comments`, { body: 'x' });
check('楼主缺帧号拒绝', noFrame.status === 400, JSON.stringify(noFrame.json)?.slice(0, 160));

// 7. 列表验证：GET 平铺含 parentId
const got = await req('GET', `/api/versions/${target.versionId}/comments`);
const all = got.json?.comments ?? [];
const mine = all.filter((c) => [rootId, r1Id, r2.json?.comment?.id].includes(c.id));
check('列表含3条测试评论', mine.length === 3, `got ${mine.length}`);
check('楼主长文完整', mine.find((c) => c.id === rootId)?.body === longBody);

// 8. 级联删除：删楼主 → 楼层全删
const del = await req('DELETE', `/api/comments/${rootId}`);
check('删除楼主', del.status === 200, JSON.stringify(del.json)?.slice(0, 120));
const after = await req('GET', `/api/versions/${target.versionId}/comments`);
const left = (after.json?.comments ?? []).filter((c) => [rootId, r1Id, r2.json?.comment?.id].includes(c.id));
check('级联删除回复', left.length === 0, `left ${left.length}`);

console.log(`结果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
