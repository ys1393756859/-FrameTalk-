import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SETTING_GROUPS, type SettingGroupKey } from '@frametalk/shared';
import { requireAdmin } from '../auth/guards.js';
import { getSetting, saveSetting, publicView, clearSettingCache } from './settings-service.js';
import { audit } from '../audit.js';

/** 系统设置：GET 全量（秘密脱敏）/ PUT 按分组保存（即时生效 + NOTIFY） */
export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { await requireAdmin(req); });

  app.get('/api/admin/settings', async () => {
    const out: Record<string, any> = {};
    for (const key of Object.keys(SETTING_GROUPS) as SettingGroupKey[]) {
      await getSetting(key); // 预热缓存 + SECRET_STORE
      out[key] = publicView(key);
    }
    return { groups: out, labels: Object.fromEntries(Object.entries(SETTING_GROUPS).map(([k, v]) => [k, (v as any).label])) };
  });

  app.put('/api/admin/settings/:group', async (req, reply) => {
    const { group } = req.params as { group: string };
    if (!(group in SETTING_GROUPS)) return reply.status(404).send({ message: '未知设置组' });
    const body = z.record(z.string(), z.unknown()).parse(req.body ?? {});
    try {
      await saveSetting(group as SettingGroupKey, body, req.user!.id);
    } catch (err: any) {
      return reply.status(400).send({ message: `保存失败: ${err.issues?.[0]?.message ?? err.message}` });
    }
    await audit(req.user!.id, 'settings.update', `设置组「${(SETTING_GROUPS[group as SettingGroupKey] as any).label ?? group}」`, req.ip, undefined, { type: 'group', id: group });
    await getSetting(group as SettingGroupKey);
    return { ok: true, group: publicView(group as SettingGroupKey) };
  });

  // 存储连通性测试（后台"测试连接"按钮）
  app.post('/api/admin/settings/storage/test', async () => {
    const cfg = await (await import('./settings-service.js')).resolveStorageConfig();
    if (cfg.backend === 'local') return { ok: true, message: '本地存储无需连接' };
    if (cfg.backend === 'webdav') {
      if (!cfg.webdavBaseUrl) return { ok: false, message: '未配置 WebDAV 地址' };
      try {
        const auth = Buffer.from(`${cfg.webdavUsername}:${cfg.webdavPassword}`).toString('base64');
        const res = await fetch(`${cfg.webdavBaseUrl.replace(/\/+$/, '')}/`, {
          method: 'PROPFIND',
          headers: { authorization: `Basic ${auth}`, depth: '0' },
        });
        if (res.status === 401) return { ok: false, message: '认证失败（检查用户名/密码）' };
        if (res.status >= 500) return { ok: false, message: `服务器错误 ${res.status}` };
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: true, message: `WebDAV 连接成功（HTTP ${res.status}）` };
      } catch (err) {
        return { ok: false, message: `连接失败: ${String(err)}` };
      }
    }
    // ftp
    if (!cfg.ftpHost) return { ok: false, message: '未配置 FTP 主机' };
    try {
      const mod = await import('basic-ftp');
      const client = new mod.Client(8000);
      await client.access({
        host: cfg.ftpHost, port: cfg.ftpPort,
        user: cfg.ftpUser, password: cfg.ftpPassword, secure: cfg.ftpSecure,
      });
      client.close();
      return { ok: true, message: `FTP 连接成功 (${cfg.ftpHost}:${cfg.ftpPort})` };
    } catch (err) {
      return { ok: false, message: `连接失败: ${String(err)}` };
    }
  });

  // 飞书通知测试（后台"测试"按钮）：校验 App 凭证 + 向目标群发一条纯文本测试消息
  app.post('/api/admin/settings/feishu/test', async (req) => {
    const { testFeishuConnection } = await import('../notify/feishu.js');
    const result = await testFeishuConnection();
    await audit(req.user!.id, 'settings.feishu_test', result.ok ? '飞书测试成功' : '飞书测试失败', req.ip);
    return result;
  });

  // 飞书群列表（后台"获取群列表"按钮）：拉机器人已加入的群，供选择 chat_id
  app.get('/api/admin/settings/feishu/chats', async () => {
    const { listFeishuChats } = await import('../notify/feishu.js');
    return listFeishuChats();
  });
}
