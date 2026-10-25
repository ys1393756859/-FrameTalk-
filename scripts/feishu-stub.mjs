#!/usr/bin/env node
/**
 * 飞书开放平台桩（冒烟测试用）：模拟服务端直连飞书所需的四个端点，全程本地、无需公网。
 *   POST /open-apis/auth/v3/tenant_access_token/internal  换 tenant_access_token
 *   POST /open-apis/contact/v3/users/batch_get_id         手机号/邮箱 → open_id
 *   POST /open-apis/im/v1/messages                        发群消息（逐行记录到 data/feishu-stub.jsonl）
 *   GET  /open-apis/im/v1/chats                           机器人已加入的群列表
 * 冒烟脚本用 FEISHU_BASE_URL=http://127.0.0.1:8800/open-apis 让服务端指向本桩。
 * 环境变量：STUB_PORT（默认 8800）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(__dirname, '../data/feishu-stub.jsonl');
const PORT = Number(process.env.STUB_PORT ?? 8800);

let msgSeq = 0;
let tokenSeq = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* keep {} */ }

    // 换 token：校验 app_id/app_secret 非空
    if (p === '/open-apis/auth/v3/tenant_access_token/internal' && req.method === 'POST') {
      if (!parsed.app_id || !parsed.app_secret) {
        return send(200, { code: 10003, msg: 'app_id 或 app_secret 无效', tenant_access_token: '', expire: 0 });
      }
      return send(200, { code: 0, msg: 'success', tenant_access_token: `t_stub_${++tokenSeq}`, expire: 7200 });
    }

    // 手机号/邮箱 → open_id（确定性映射，便于断言）
    if (p === '/open-apis/contact/v3/users/batch_get_id' && req.method === 'POST') {
      const list = [];
      for (const m of (parsed.mobiles ?? [])) list.push({ user_id: `ou_m_${m}`, mobile: m, email: '' });
      for (const e of (parsed.emails ?? [])) list.push({ user_id: `ou_e_${e}`, mobile: '', email: e });
      console.log(`[stub] batch_get_id: mobiles=${JSON.stringify(parsed.mobiles ?? [])} emails=${JSON.stringify(parsed.emails ?? [])} → ${list.length} open_id`);
      return send(200, { code: 0, msg: 'success', data: { user_list: list } });
    }

    // 发群消息：记录到 jsonl（冒烟按行数统计"发送了几条"）
    if (p === '/open-apis/im/v1/messages' && req.method === 'POST') {
      let text = '';
      try {
        const c = JSON.parse(parsed.content ?? '{}');
        // interactive 的 content 是卡片 JSON 字符串，原样记录供冒烟断言结构
        text = parsed.msg_type === 'text' ? (c.text ?? '') : String(parsed.content ?? '');
      } catch { text = String(parsed.content ?? ''); }
      const entry = { at: new Date().toISOString(), receive_id: parsed.receive_id, msg_type: parsed.msg_type, text };
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
      console.log(`[stub] im/v1/messages #${msgSeq + 1}: chat=${parsed.receive_id} type=${parsed.msg_type} at数=${(text.match(/<at /g) ?? []).length} text="${text.split('\n')[0].slice(0, 120)}"`);
      return send(200, { code: 0, msg: 'success', data: { message_id: `om_stub_${++msgSeq}`, create_time: String(Date.now()) } });
    }

    // 群列表
    if (p === '/open-apis/im/v1/chats' && req.method === 'GET') {
      return send(200, {
        code: 0, msg: 'success',
        data: { items: [{ chat_id: 'oc_test', name: '冒烟测试群', description: '' }], has_more: false },
      });
    }

    send(200, { code: 404, msg: `stub: 未实现的端点 ${req.method} ${p}` });
  });
}).listen(PORT, () => console.log(`[stub] 飞书开放平台桩监听 127.0.0.1:${PORT}，消息日志: ${LOG}`));
