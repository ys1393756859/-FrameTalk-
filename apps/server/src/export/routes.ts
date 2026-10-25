import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db.js';
import { requireAuth, requireProjectRole, httpError } from '../auth/guards.js';
import { commentsCsv, commentsEdl, commentsFcpXml, type ExportComment } from './generators.js';
import { sourceTimecode, type Fps } from '@frametalk/shared';
import { audit } from '../audit.js';

/**
 * PDF 中文字体：PDFKit 内置的 Helvetica 没有中文字形，不注册字体时中文全乱码。
 * 依次尝试：项目 assets/fonts/（部署时放一份最稳）→ 各系统常见中文字体。
 * 注意 .ttc 字体集合 PDFKit 加载不了，只认 .ttf/.otf。
 * 全部找不到则回退默认字体（英文数字正常，中文乱码——服务器务必装字体）。
 */
let cachedFontPath: string | null | undefined;
function findCjkFont(): string | null {
  if (cachedFontPath !== undefined) return cachedFontPath;
  const candidates = [
    // Windows：黑体（simhei 恒为 .ttf；msyh 微软雅黑常为 .ttc 加载不了，仅兜底 ttf 版）
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyh.ttf',
    // Linux：docker 镜像装 fonts-noto-cjk / fonts-wqy-zenhei（ttf 版）
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  ];
  // 项目自带优先
  try {
    const dir = path.resolve(import.meta.dirname, '../../assets/fonts');
    if (fs.existsSync(dir)) {
      const f = fs.readdirSync(dir).find((n) => /\.(ttf|otf)$/i.test(n));
      if (f) { cachedFontPath = path.join(dir, f); return cachedFontPath; }
    }
  } catch { /* ignore */ }
  for (const p of candidates) {
    if (fs.existsSync(p)) { cachedFontPath = p; return cachedFontPath; }
  }
  cachedFontPath = null;
  return null;
}

async function loadForExport(req: any, versionId: string) {
  const user = await requireAuth(req);
  const version = await prisma.assetVersion.findUnique({
    where: { id: versionId }, include: { asset: true },
  });
  if (!version) throw httpError(404, '版本不存在');
  await requireProjectRole(user, version.asset.projectId, 'viewer');
  const comments = await prisma.comment.findMany({
    where: { versionId },
    orderBy: [{ frameIn: 'asc' }, { createdAt: 'asc' }],
    include: { author: { select: { name: true } } },
  });
  const list: ExportComment[] = comments.map((c) => ({
    id: c.id, authorName: c.author.name, frameIn: c.frameIn, frameOut: c.frameOut,
    body: c.body, labels: c.labels, resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  }));
  const fps: Fps = { num: version.fpsNum ?? 25, den: version.fpsDen ?? 1 };
  return { user, version, comments: list, fps };
}

export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/versions/:versionId/export/csv', async (req, reply) => {
    const { version, comments, fps } = await loadForExport(req, (req.params as any).versionId);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${version.asset.name}-v${version.versionNo}.csv`)}`);
    await audit((req as any).user!.id, 'export.csv', `版本 ${version.asset.name}-v${version.versionNo}`, req.ip, undefined, { type: 'version', id: version.id });
    return commentsCsv(comments, fps, version.startFrames);
  });

  app.get('/api/versions/:versionId/export/edl', async (req, reply) => {
    const { version, comments, fps } = await loadForExport(req, (req.params as any).versionId);
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${version.asset.name}-v${version.versionNo}.edl`)}`);
    await audit((req as any).user!.id, 'export.edl', `版本 ${version.asset.name}-v${version.versionNo}`, req.ip, undefined, { type: 'version', id: version.id });
    return commentsEdl(comments, fps, version.startFrames, `${version.asset.name}-v${version.versionNo}`);
  });

  app.get('/api/versions/:versionId/export/xml', async (req, reply) => {
    const { version, comments, fps } = await loadForExport(req, (req.params as any).versionId);
    reply.header('content-type', 'application/xml; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${version.asset.name}-v${version.versionNo}.xml`)}`);
    await audit((req as any).user!.id, 'export.xml', `版本 ${version.asset.name}-v${version.versionNo}`, req.ip, undefined, { type: 'version', id: version.id });
    return commentsFcpXml(comments, fps, version.startFrames, `${version.asset.name}-v${version.versionNo}`, version.frameCount ?? 0);
  });

  /** PDF：前端把每条批注的帧截图（含画笔）base64 传上来 */
  app.post('/api/versions/:versionId/export/pdf', async (req, reply) => {
    const { version, comments, fps } = await loadForExport(req, (req.params as any).versionId);
    const input = z.object({
      items: z.array(z.object({ commentId: z.string(), image: z.string().optional() })).max(500),
    }).parse(req.body);
    const imageMap = new Map(input.items.filter((i) => i.image?.startsWith('data:image')).map((i) => [i.commentId, i.image!]));

    const filename = encodeURIComponent(`${version.asset.name}-v${version.versionNo}.pdf`);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename*=UTF-8''${filename}`,
    });
    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false });
    // 中文渲染必须注册中文字体（见 findCjkFont 注释）
    const cjkFont = findCjkFont();
    if (cjkFont) doc.registerFont('cjk', cjkFont);
    const font = () => cjkFont && doc.font('cjk');
    doc.pipe(reply.raw);

    const stamp = new Date().toLocaleString('zh-CN');
    for (const c of comments) {
      doc.addPage();
      let y = 40;
      font(); doc.fontSize(9).fillColor('#888')
        .text(`${version.asset.name}  v${version.versionNo}  ·  ${stamp}  ·  ${comments.length} 条批注`, 40, y);
      y += 16;
      const tc = sourceTimecode(c.frameIn, fps, version.startFrames)
        + (c.frameOut != null ? ` ~ ${sourceTimecode(c.frameOut, fps, version.startFrames)}` : '');
      font(); doc.fontSize(14).fillColor('#111').text(`# ${tc}`, 40, y);
      y += 22;
      font(); doc.fontSize(10).fillColor('#444').text(`${c.authorName}  ${new Date(c.createdAt).toLocaleString('zh-CN')}${c.resolvedAt ? '  [已解决]' : ''}`, 40, y);
      y += 18;
      const img = imageMap.get(c.id);
      if (img) {
        try {
          const buf = Buffer.from(img.slice(img.indexOf(',') + 1), 'base64');
          doc.image(buf, 40, y, { width: 515 });
          y += 300;
        } catch { /* 坏图跳过 */ }
      }
      font(); doc.fontSize(11).fillColor('#000');
      if (c.labels.length) {
        doc.fillColor('#c00').text(`标签: ${c.labels.join(' / ')}`, 40, Math.min(y + 4, 760));
        y += 18;
      }
      doc.fillColor('#000').text(c.body ?? '（画笔批注）', 40, Math.min(y, 770), { width: 515 });
    }
    if (!comments.length) {
      doc.addPage();
      font(); doc.fontSize(12).text('暂无批注', 40, 40);
    }
    doc.end();
    await audit((req as any).user!.id, 'export.pdf', `版本 ${version.asset.name}-v${version.versionNo}`, req.ip, undefined, { type: 'version', id: version.id });
  });
}
