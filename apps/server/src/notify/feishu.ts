/**
 * 飞书通知：新评论 → FeishuNotifyBuffer 按项目聚合 → 服务端直连飞书开放平台双通道投递。
 * 无需外部中转服务：本模块内置 tenant_access_token 管理、手机号/邮箱→open_id、im 发消息（原生 fetch）。
 * 仅需部署机能「出站」访问 open.feishu.cn:443（飞书不回调本服务，无需公网 IP / 入站端口）。
 *
 * 双通道投递（互不阻塞，任一成功即勾掉本批；都失败才重试）：
 *  - 群卡片：仅顶层评论进群，@ 项目成员（卡片 interactive，被拒降级纯文本）；
 *  - 私信：顶层评论私信全体成员（−作者，除非 atAuthor）+ 被 @ 者；
 *    线程回复只私信线程参与者与被 @ 者（不进群），且绕过聚合窗口立即送达。
 *
 * 「度」（不是每条评论都 @）由四道闸门控制，后台 → 系统设置 → 飞书通知 可配：
 *  1. 聚合窗口 windowMinutes：首条评论入缓冲后等满窗口再发，期间评论合并为一条摘要；
 *  2. 显式 @提及 绕过 mentionBypass：批注里 @ 了具体人视为紧急，立即冲刷整个缓冲
 *     （仍受 MIN_SEND_GAP 最小发送间隔约束，防连发轰炸）；
 *  3. 免打扰 quietStart~quietEnd：期间不发，缓冲累积，免打扰结束合并成一条；
 *  4. 每日上限 dailyMax（每项目，0=不限）：超限丢弃并记日志。
 *
 * 缓冲持久化在 DB，进程重启不丢摘要；30s sweeper 扫描到期缓冲（api.ts 启动），
 * 进程内 setTimeout 做即时触发，两者共用 per-project 互斥锁防双发。
 * 发送失败 2 分钟后重试，连续 MAX_ATTEMPTS 次失败放弃该批（防止配置错误时无限刷群）。
 */
import { prisma } from '../db.js';
import { getSetting, getSecret } from '../admin/settings-service.js';
import { reqlog } from '../audit.js';

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  chatId: string;
  windowMinutes: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  mentionBypass: boolean;
  atAuthor: boolean;
  platformUrl: string;
}

/** 评论事件（review/routes.ts 创建成功后投递） */
export interface FeishuCommentEvent {
  projectId: string;
  commentId: string;
  /** top 顶层评论（进群+私信成员）| reply 线程回复（仅私信相关人） */
  kind: 'top' | 'reply';
  /** 私信直达名单：回复=线程参与者+@，顶层=@（成员名单在发送时算） */
  dmUserIds: string[];
  assetId: string;
  assetName: string;
  frameIn: number;
  frameOut: number | null;
  body: string | null;
  hasDrawing: boolean;
  attachmentCount: number;
  authorId: string;
  authorName: string;
  mentions: string[];
}

/** 缓冲里的单条评论摘要（存 FeishuNotifyBuffer.pending） */
interface BufferItem extends Omit<FeishuCommentEvent, 'projectId' | 'mentions'> {
  mentionCount: number;
  at: string; // ISO 时间
}

const MIN_SEND_GAP_MS = 30_000;   // 两条 @ 消息最小间隔（绕过窗口时也生效）
const MAX_ATTEMPTS = 5;           // 连续发送失败上限，超过丢弃缓冲
const RETRY_DELAY_MS = 2 * 60_000; // 发送失败重试延迟
const SEND_LEASE_MS = 60_000;     // 跨进程 claim 租约：抢占后 60s 内未写回终态则视为持有者崩溃，允许重发
const STALE_HOURS = 24;           // 缓冲超过该时长作废（如功能被关闭后重新打开）
const MAX_ITEMS_IN_TEXT = 20;     // 单条摘要最多列出的评论数，超出显示"等 N 条"
const BODY_SNIPPET = 60;          // 每条评论正文截断长度
const SWEEP_INTERVAL_MS = 30_000;
const RESOLVE_BATCH = 50;         // 飞书 batch_get_id 单批上限

// 飞书开放平台基址（默认线上；env FEISHU_BASE_URL 可覆盖以便本地桩测试）
const FEISHU_BASE = (process.env.FEISHU_BASE_URL ?? 'https://open.feishu.cn/open-apis').replace(/\/+$/, '');

// tenant_access_token 进程内缓存（按 appId 失效，提前 60s 刷新；in-flight 去重防并发换取）
let tokenCache: { appId: string; token: string; expireAt: number } | null = null;
let tokenInflight: Promise<{ token: string | null; error: string | null }> | null = null;

async function loadConfig(): Promise<FeishuConfig> {
  const s = await getSetting<any>('feishu');
  return {
    ...s,
    appId: String(s.appId ?? '').trim(),
    appSecret: getSecret('feishu', 'appSecret') ?? '',
  };
}

// ---- per-project 互斥（单进程内 append / flush 串行，防读改写竞态与双发） ----
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(projectId, tail);
  void tail.then(() => { if (locks.get(projectId) === tail) locks.delete(projectId); });
  return run;
}

// ---- 定时器 ----
const timers = new Map<string, NodeJS.Timeout>();
function scheduleFlush(projectId: string, dueAt: Date) {
  const old = timers.get(projectId);
  if (old) clearTimeout(old);
  const delay = Math.max(dueAt.getTime() - Date.now(), 0);
  timers.set(projectId, setTimeout(() => {
    timers.delete(projectId);
    void flushProject(projectId);
  }, delay));
}

// ---- 免打扰（本地时区 HH:mm，支持跨午夜） ----
function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function inQuietHours(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s == null || e == null || s === e) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return s < e ? (t >= s && t < e) : (t >= s || t < e);
}

function nextQuietEnd(now: Date, end: string): Date {
  const e = parseHHMM(end) ?? 0;
  const d = new Date(now);
  d.setHours(Math.floor(e / 60), e % 60, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function dayStampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * 评论创建后调用（fire-and-forget，内部吞异常，绝不影响评论主流程）。
 */
export function queueFeishuNotify(evt: FeishuCommentEvent): void {
  void (async () => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.appId || !cfg.appSecret || !cfg.chatId) return;
      await withLock(evt.projectId, async () => {
        const now = new Date();
        const buf = await prisma.feishuNotifyBuffer.findUnique({ where: { projectId: evt.projectId } });
        const pending = (((buf?.pending as any) ?? []) as BufferItem[]).slice();
        const item: BufferItem = {
          commentId: evt.commentId,
          kind: evt.kind,
          dmUserIds: evt.dmUserIds,
          assetId: evt.assetId,
          assetName: evt.assetName,
          frameIn: evt.frameIn,
          frameOut: evt.frameOut,
          body: evt.body,
          hasDrawing: evt.hasDrawing,
          attachmentCount: evt.attachmentCount,
          authorId: evt.authorId,
          authorName: evt.authorName,
          mentionCount: evt.mentions.filter((id) => id !== evt.authorId).length,
          at: now.toISOString(),
        };
        pending.push(item);
        // 线程回复只私信相关人，时效性强：同显式 @ 一样绕过聚合窗口立即冲刷
        const urgent = (cfg.mentionBypass && item.mentionCount > 0) || item.kind === 'reply';
        let dueAt: Date;
        if (urgent) {
          // 显式 @提及：尽快发，但与上一条至少间隔 MIN_SEND_GAP
          const gap = buf?.lastSentAt ? buf.lastSentAt.getTime() + MIN_SEND_GAP_MS : 0;
          dueAt = new Date(Math.max(now.getTime(), gap));
        } else if (!buf?.dueAt || pending.length === 1) {
          // 新一轮缓冲：从首条评论起等满聚合窗口
          dueAt = new Date(now.getTime() + cfg.windowMinutes * 60_000);
        } else {
          dueAt = buf.dueAt; // 窗口内追加，维持原到期时间
        }
        await prisma.feishuNotifyBuffer.upsert({
          where: { projectId: evt.projectId },
          create: { projectId: evt.projectId, pending: pending as any, firstAt: now, dueAt },
          update: { pending: pending as any, firstAt: buf?.firstAt ?? now, dueAt },
        });
        scheduleFlush(evt.projectId, dueAt);
      });
    } catch (err) {
      reqlog('warn', `feishu: 评论入缓冲失败 ${String(err)}`);
    }
  })();
}

/** 冲刷一个项目的缓冲（到期才真正发送；免打扰/未到期则改期重调度） */
export async function flushProject(projectId: string): Promise<void> {
  try {
    await withLock(projectId, async () => {
      const buf = await prisma.feishuNotifyBuffer.findUnique({ where: { projectId } });
      const pending = (((buf?.pending as any) ?? []) as BufferItem[]);
      if (!buf || pending.length === 0) return;
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.appId || !cfg.appSecret || !cfg.chatId) return; // 关闭/配置不全：留给 sweeper，超龄自动作废
      const now = new Date();

      // 过期缓冲作废（功能长时间关闭后重开，不 @ 一堆陈年评论）
      if (buf.firstAt && now.getTime() - buf.firstAt.getTime() > STALE_HOURS * 3600_000) {
        reqlog('info', `feishu: 项目 ${projectId} 缓冲超过 ${STALE_HOURS}h，作废 ${pending.length} 条评论摘要`);
        await clearBuffer(projectId);
        return;
      }
      // 未到期：重挂定时器即可
      if (buf.dueAt && buf.dueAt.getTime() > now.getTime()) {
        scheduleFlush(projectId, buf.dueAt);
        return;
      }
      // 免打扰：推迟到免打扰结束
      if (inQuietHours(now, cfg.quietStart, cfg.quietEnd)) {
        const end = nextQuietEnd(now, cfg.quietEnd);
        await prisma.feishuNotifyBuffer.update({ where: { projectId }, data: { dueAt: end } });
        scheduleFlush(projectId, end);
        return;
      }
      // 每日上限
      const stamp = dayStampOf(now);
      const sentToday = buf.dayStamp === stamp ? buf.sentToday : 0;
      if (cfg.dailyMax > 0 && sentToday >= cfg.dailyMax) {
        reqlog('warn', `feishu: 项目 ${projectId} 已达当日 @ 上限 ${cfg.dailyMax}，丢弃 ${pending.length} 条评论摘要`);
        await clearBuffer(projectId);
        return;
      }

      // 跨进程原子抢占（租约）：多实例各自的定时器/sweeper 可能同时到期，进程内锁不够，
      // 用条件 UPDATE 保证同一批摘要只被一个发送者持有；成功/失败都会写回终态覆盖租约。
      const claim = await prisma.feishuNotifyBuffer.updateMany({
        where: { projectId, dueAt: { lte: new Date() } },
        data: { dueAt: new Date(Date.now() + SEND_LEASE_MS) },
      });
      if (claim.count === 0) return; // 已被其他实例抢走或已不满足到期条件

      // ---- 投递计划：群卡片（仅顶层评论）+ 逐人私信（回复/@ 精准直达）----
      const topItems = pending.filter((i) => i.kind !== 'reply');
      const [project, members] = await Promise.all([
        prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
        prisma.projectMember.findMany({
          where: { projectId },
          select: { userId: true, user: { select: { phone: true, email: true } } },
        }),
      ]);
      const projectName = project?.name ?? '项目';
      const memberIdent = new Map<string, string>();
      for (const m of members) {
        const idt = identityOf(m.user);
        if (idt) memberIdent.set(m.userId, idt);
      }
      const extraIds = [...new Set(pending.flatMap((i) => i.dmUserIds ?? []))].filter((id) => !memberIdent.has(id));
      const extraUsers = extraIds.length
        ? await prisma.user.findMany({ where: { id: { in: extraIds } }, select: { id: true, phone: true, email: true } })
        : [];
      const identOf = (uid: string): string | null => {
        if (memberIdent.has(uid)) return memberIdent.get(uid)!;
        const u = extraUsers.find((x) => x.id === uid);
        return u ? identityOf(u) : null;
      };

      // 每条评论的私信名单：顶层=成员−作者（+@），回复=线程参与者+@
      const groupIdents = new Set<string>();
      const itemIdents = new Map<string, Set<string>>();
      for (const i of pending) {
        const set = new Set<string>();
        if (i.kind !== 'reply') {
          for (const [uid, idt] of memberIdent) {
            if (uid === i.authorId && !cfg.atAuthor) continue;
            set.add(idt);
          }
          for (const idt of set) groupIdents.add(idt);
        }
        for (const uid of i.dmUserIds ?? []) {
          const idt = identOf(uid);
          if (idt) set.add(idt);
        }
        itemIdents.set(i.commentId, set);
      }
      const allIdents = [...new Set([...groupIdents, ...[...itemIdents.values()].flatMap((s) => [...s])])];
      if (allIdents.length === 0) {
        reqlog('warn', `feishu: 项目 ${projectId} 无可通知成员（成员均未填手机号/邮箱），丢弃摘要`);
        await clearBuffer(projectId);
        return;
      }

      // 两通道独立发送、互不阻塞：群失败不影响私信，反之亦然；都失败才进重试
      let failMsg = '';
      let groupOk = false;
      let dmOk = false;
      const groupAttempted = topItems.length > 0 && !!cfg.chatId;
      const { token, error: tokenErr } = await getToken(cfg);
      if (!token) {
        failMsg = `获取 tenant_access_token 失败: ${tokenErr}`;
      } else {
        const openIdByIdent = await resolveOpenIdMap(allIdents, token);
        if (openIdByIdent.size === 0 && !groupAttempted) {
          reqlog('warn', `feishu: 项目 ${projectId} 所有手机/邮箱均未匹配到飞书账号且无群可发，丢弃摘要`);
          await clearBuffer(projectId);
          return;
        }
        if (groupAttempted) {
          const gData = buildSummaryData(projectId, projectName, topItems);
          const gOpenIds = [...groupIdents].map((idt) => openIdByIdent.get(idt)).filter(Boolean) as string[];
          groupOk = await sendChannel(cfg, token, { type: 'group' }, buildCard(gData, gOpenIds, cfg), gData.text) === 'ok';
          if (!groupOk) failMsg += '群消息发送失败; ';
        }
        const dmRecipients = allIdents
          .map((idt) => ({ idt, openId: openIdByIdent.get(idt) }))
          .filter((r): r is { idt: string; openId: string } => !!r.openId)
          .map((r) => ({ ...r, items: pending.filter((i) => itemIdents.get(i.commentId)?.has(r.idt)) }))
          .filter((r) => r.items.length > 0);
        for (const r of dmRecipients) {
          const dData = buildSummaryData(projectId, projectName, r.items);
          const ok = await sendChannel(cfg, token, { type: 'dm', openId: r.openId }, buildDmCard(dData, cfg), dData.text) === 'ok';
          if (ok) dmOk = true;
          else reqlog('warn', `feishu: 私信 ${r.idt} 发送失败（不在应用可用范围？）`);
          await new Promise((res) => setTimeout(res, 250)); // 平台频控缓冲
        }
      }
      const anyOk = groupOk || dmOk;
      if (anyOk) {
        // 只勾掉本批已发送的评论：发送瞬间新入缓冲的评论保留，按新窗口重新排期
        const sentIds = new Set(pending.map((i) => i.commentId));
        const fresh = await prisma.feishuNotifyBuffer.findUnique({ where: { projectId } });
        const rest = (((fresh?.pending as any) ?? []) as BufferItem[]).filter((i) => !sentIds.has(i.commentId));
        const firstRest = rest[0];
        const restDue = rest.length ? new Date(Date.now() + cfg.windowMinutes * 60_000) : null;
        await prisma.feishuNotifyBuffer.update({
          where: { projectId },
          data: {
            pending: rest as any,
            firstAt: firstRest ? new Date(firstRest.at) : null,
            dueAt: restDue,
            lastSentAt: now, sentToday: sentToday + 1, dayStamp: stamp, attempts: 0,
          },
        });
        if (restDue) scheduleFlush(projectId, restDue);
        reqlog('info', `feishu: 项目 ${projectId} 摘要已投递（${pending.length} 条；群 ${groupOk ? '✓' : '−'}，私信 ${dmOk ? '✓' : '−'}）`);
      } else {
        const attempts = buf.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          reqlog('error', `feishu: 连续 ${MAX_ATTEMPTS} 次发送失败，丢弃缓冲。最后错误: ${failMsg}`);
          await clearBuffer(projectId);
        } else {
          const retry = new Date(Date.now() + RETRY_DELAY_MS);
          await prisma.feishuNotifyBuffer.update({ where: { projectId }, data: { dueAt: retry, attempts } });
          scheduleFlush(projectId, retry);
          reqlog('warn', `feishu: 发送失败（第 ${attempts}/${MAX_ATTEMPTS} 次）: ${failMsg}`);
        }
      }
    });
  } catch (err) {
    reqlog('warn', `feishu: flush 异常 project=${projectId} ${String(err)}`);
  }
}

async function clearBuffer(projectId: string) {
  await prisma.feishuNotifyBuffer.update({
    where: { projectId },
    data: { pending: [], firstAt: null, dueAt: null, attempts: 0 },
  });
}

/** 摘要数据：纯文本版（降级兜底）与卡片版都由它渲染 */
interface SummaryData {
  projectId: string;
  projectName: string;
  multi: boolean;
  assetNames: string[];
  count: number;
  urgent: boolean; // 含显式 @提及 的评论：卡片标题用红色
  mdLines: string[];
  text: string;
  linkAssetId: string | null; // 单集批次时深链到该集批注页
}

/** 用户在飞书侧的身份标识：手机号优先，其次邮箱（batch_get_id 两种都支持） */
function identityOf(u: { phone: string | null; email: string | null }): string | null {
  return u.phone?.trim() || u.email?.trim() || null;
}

/** 纯渲染：一批评论 → 摘要数据（文本/卡片共用；回复条目带「·回复」标记） */
function buildSummaryData(projectId: string, projectName: string, items: BufferItem[]): SummaryData {
  const assetNames = [...new Set(items.map((i) => i.assetName))];
  const multi = assetNames.length > 1;
  const textLines: string[] = [];
  const mdLines: string[] = [];
  for (const i of items.slice(0, MAX_ITEMS_IN_TEXT)) {
    const frame = i.frameOut != null && i.frameOut !== i.frameIn
      ? `帧 ${i.frameIn}-${i.frameOut}` : `帧 ${i.frameIn}`;
    const content = [
      i.body?.trim() ? truncate(i.body, BODY_SNIPPET) : '',
      i.hasDrawing ? '[画笔]' : '',
      i.attachmentCount ? `[附件×${i.attachmentCount}]` : '',
    ].filter(Boolean).join(' ') || '[内容]';
    const d = new Date(i.at);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ep = multi ? `${i.assetName} ` : '';
    const replyTag = i.kind === 'reply' ? '·回复' : '';
    const mention = i.mentionCount > 0 ? ' [@提及]' : '';
    textLines.push(`· ${hhmm} ${ep}${frame} ${i.authorName}${replyTag}：${content}${mention}`);
    mdLines.push(`**${hhmm} ${ep}${frame} ${i.authorName}${replyTag}**：${content}${mention}`);
  }
  if (items.length > MAX_ITEMS_IN_TEXT) {
    textLines.push(`· ……等共 ${items.length} 条`);
    mdLines.push(`……等共 ${items.length} 条`);
  }
  const head = multi
    ? `【${projectName}】新增 ${items.length} 条评论（涉及 ${assetNames.length} 集）`
    : `【${projectName} · ${assetNames[0]}】新增 ${items.length} 条评论`;
  const text = [head, ...textLines, '登录帧言查看与回复'].join('\n');
  return {
    projectId, projectName, multi, assetNames, count: items.length,
    urgent: items.some((i) => i.mentionCount > 0),
    mdLines, text,
    linkAssetId: multi ? null : (items[0]?.assetId || null),
  };
}

/** 飞书卡片（msg_type=interactive，卡片 JSON 1.0）：彩色标题栏 + markdown 正文 + 深链按钮 + 脚注 */
function buildCard(s: SummaryData, openIds: string[], cfg: FeishuConfig) {
  const elements: any[] = [];
  if (openIds.length) {
    elements.push({ tag: 'markdown', content: openIds.map((id) => `<at id="${id}"></at>`).join(' ') });
  }
  elements.push({ tag: 'markdown', content: s.mdLines.join('\n') });
  const base = (cfg.platformUrl ?? '').trim().replace(/\/+$/, '');
  if (base) {
    const url = s.linkAssetId ? `${base}/p/${s.projectId}/a/${s.linkAssetId}` : `${base}/p/${s.projectId}`;
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button', text: { tag: 'plain_text', content: '去帧言查看与回复' }, type: 'primary', url,
      }],
    });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `聚合窗口 ${cfg.windowMinutes} 分钟 · 每日上限 ${cfg.dailyMax || '不限'} 条` }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: s.urgent ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: s.multi
          ? `${s.projectName}｜新增 ${s.count} 条评论（涉及 ${s.assetNames.length} 集）`
          : `${s.projectName} · ${s.assetNames[0]}｜新增 ${s.count} 条评论`,
      },
    },
    elements,
  };
}

/** 私信卡片：与群卡片同构，但标题面向收件人（「N 条评论与你相关」） */
function buildDmCard(s: SummaryData, cfg: FeishuConfig) {
  const elements: any[] = [
    { tag: 'markdown', content: s.mdLines.join('\n') },
  ];
  const base = (cfg.platformUrl ?? '').trim().replace(/\/+$/, '');
  if (base) {
    const url = s.linkAssetId ? `${base}/p/${s.projectId}/a/${s.linkAssetId}` : `${base}/p/${s.projectId}`;
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button', text: { tag: 'plain_text', content: '去帧言查看与回复' }, type: 'primary', url,
      }],
    });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '来自帧言的私信提醒 · 回复评论后相关人会继续收到私信' }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: s.urgent ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: s.multi
          ? `${s.projectName}｜${s.count} 条评论与你相关（涉及 ${s.assetNames.length} 集）`
          : `${s.projectName} · ${s.assetNames[0]}｜${s.count} 条评论与你相关`,
      },
    },
    elements,
  };
}

// ---- 飞书开放平台直连客户端（融合自 feishu-at-bot，无外部中转） ----

/** 统一 JSON 请求：网络异常/超时/非 JSON 都归一成 {code,msg}，绝不抛异常 */
async function fetchJson(method: string, url: string, body?: unknown, token?: string): Promise<any> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return await res.json().catch(() => ({ code: res.status, msg: `HTTP ${res.status}` }));
  } catch (err) {
    return { code: -1, msg: String(err) };
  }
}

/** 换取并缓存 tenant_access_token（提前 60s 刷新；并发只换取一次） */
async function getToken(cfg: FeishuConfig): Promise<{ token: string | null; error: string | null }> {
  if (tokenCache && tokenCache.appId === cfg.appId && Date.now() < tokenCache.expireAt - 60_000) {
    return { token: tokenCache.token, error: null };
  }
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    try {
      const data = await fetchJson('POST', `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
        { app_id: cfg.appId, app_secret: cfg.appSecret });
      if (data.code !== 0 || !data.tenant_access_token) {
        return { token: null, error: data.msg || `code ${data.code}` };
      }
      tokenCache = {
        appId: cfg.appId,
        token: data.tenant_access_token as string,
        expireAt: Date.now() + (Number(data.expire) || 7200) * 1000,
      };
      return { token: tokenCache.token, error: null };
    } finally {
      tokenInflight = null;
    }
  })();
  return tokenInflight;
}

/** 手机号/邮箱 → open_id 映射（分批，每批 ≤50；未匹配的静默跳过，不抛异常） */
async function resolveOpenIdMap(idents: string[], token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < idents.length; i += RESOLVE_BATCH) {
    const batch = idents.slice(i, i + RESOLVE_BATCH);
    const body: { mobiles?: string[]; emails?: string[] } = {};
    for (const v of batch) {
      if (v.includes('@')) (body.emails ??= []).push(v);
      else (body.mobiles ??= []).push(v);
    }
    const data = await fetchJson('POST',
      `${FEISHU_BASE}/contact/v3/users/batch_get_id?user_id_type=open_id`, body, token);
    if (data.code !== 0) {
      reqlog('warn', `feishu: batch_get_id 失败 code=${data.code} ${data.msg ?? ''}`);
      continue;
    }
    for (const u of (data.data?.user_list ?? [])) {
      if (!u?.user_id) continue;
      const key = String(u.mobile || u.email || '').trim();
      if (key) map.set(key, u.user_id);
    }
  }
  return map;
}

/**
 * 单通道发送（群 chat_id / 私信 open_id）：卡片优先，卡片被拒自动降级纯文本。
 * 绝不抛异常；两通道由调用方独立调用，任一失败不影响另一个（兜底互不阻塞）。
 */
async function sendChannel(
  cfg: FeishuConfig, token: string,
  target: { type: 'group' } | { type: 'dm'; openId: string },
  card: unknown, fallbackText: string,
): Promise<'ok' | 'fail'> {
  const receiveIdType = target.type === 'group' ? 'chat_id' : 'open_id';
  const receiveId = target.type === 'group' ? cfg.chatId : target.openId;
  if (!receiveId) return 'fail';
  const url = `${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`;
  const send = (msgType: 'text' | 'interactive', content: string) =>
    fetchJson('POST', url, { receive_id: receiveId, msg_type: msgType, content }, token);
  let data = await send('interactive', JSON.stringify(card));
  if (data.code !== 0) {
    reqlog('warn', `feishu: ${target.type === 'group' ? '群' : '私信'}卡片发送失败 code=${data.code} ${data.msg ?? ''}，降级纯文本`);
    data = await send('text', JSON.stringify({ text: fallbackText }));
  }
  return data.code === 0 ? 'ok' : 'fail';
}

/**
 * 后台「测试」按钮：校验 App 凭证（换 tenant_access_token）→ 向目标群发一条卡片测试消息（不 @ 人）。
 */
export async function testFeishuConnection(): Promise<{ ok: boolean; message: string }> {
  const cfg = await loadConfig();
  if (!cfg.appId || !cfg.appSecret) return { ok: false, message: '未配置 App ID / App Secret' };
  const { token, error } = await getToken(cfg);
  if (!token) return { ok: false, message: `凭证校验失败（检查 App ID/Secret）: ${error}` };
  if (!cfg.chatId) return { ok: true, message: '凭证有效；未配置目标群 chat_id，仅完成凭证校验' };
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '【帧言】飞书通知测试消息' } },
    elements: [
      { tag: 'markdown', content: '配置已生效：顶层评论将发**群卡片**并**私信项目成员**；回复/@ 仅私信相关人。' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '本条为测试样例，不 @ 任何成员' }] },
    ],
  };
  const ok = await sendChannel(cfg, token, { type: 'group' }, card, '【帧言】飞书通知测试消息（卡片被拒时的纯文本降级样例）') === 'ok';
  return ok
    ? { ok: true, message: '测试卡片已发送到目标群（不 @ 人）' }
    : { ok: false, message: '测试消息发送失败（检查机器人是否已入群、是否有 im:message 权限）' };
}

/** 后台「获取群列表」：拉机器人已加入的群，供选择 chat_id（需 im:chat 只读权限） */
export async function listFeishuChats(): Promise<{ ok: boolean; message?: string; chats?: Array<{ chat_id: string; name: string }> }> {
  const cfg = await loadConfig();
  if (!cfg.appId || !cfg.appSecret) return { ok: false, message: '请先填写并保存 App ID / App Secret' };
  const { token, error } = await getToken(cfg);
  if (!token) return { ok: false, message: `获取 token 失败: ${error}` };
  const data = await fetchJson('GET', `${FEISHU_BASE}/im/v1/chats?page_size=100`, undefined, token);
  if (data.code !== 0) return { ok: false, message: `获取群列表失败 code=${data.code}: ${data.msg ?? ''}（需 im:chat 只读权限）` };
  const chats = (data.data?.items ?? []).map((c: any) => ({ chat_id: c.chat_id, name: c.name ?? '(未命名群)' }));
  return { ok: true, chats };
}

/** api.ts 启动时调用：30s 扫描到期缓冲（兜底重启丢定时器），并为存量缓冲重挂定时器 */
export function startFeishuSweeper(): void {
  const tick = async () => {
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) return;
      const now = new Date();
      const rows = await prisma.feishuNotifyBuffer.findMany({ where: { dueAt: { not: null } } });
      for (const row of rows) {
        if (!timers.has(row.projectId) && row.dueAt && row.dueAt > now) {
          scheduleFlush(row.projectId, row.dueAt); // 重启后恢复未到期的定时器
        } else if (row.dueAt && row.dueAt <= now) {
          await flushProject(row.projectId);
        }
      }
    } catch (err) {
      reqlog('warn', `feishu sweeper: ${String(err)}`);
    }
  };
  const t = setInterval(() => { void tick(); }, SWEEP_INTERVAL_MS);
  t.unref?.();
  void tick();
  reqlog('info', 'feishu sweeper 已启动（30s）');
}
