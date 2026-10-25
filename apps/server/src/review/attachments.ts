import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { prisma } from '../db.js';
import { mediaDir } from '../env.js';
import { requireAuth, requireMember, httpError } from '../auth/guards.js';
import { ensureDir, sanitizeFilename } from '../util.js';

// 批注附件：图片/视频/文档。先上传（commentId 为空），提交批注时绑定。
// 文件存 MEDIA_DIR/attachments/<attachmentId>/<filename>，读取带权限校验。

/** 单附件上限 500MB */
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;

/** 可预览（inline）的附件类型；其余一律 attachment 下载 */
const INLINE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/ogg',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
]);

export async function attachmentRoutes(app: FastifyInstance) {
  // multipart 上传：手工解析边界（项目未引 @fastify/multipart，避免新依赖）
  // bodyLimit 必须放宽：Fastify 默认 1MB，超过会在进路由前直接 413，路由内的 500MB 校验永远走不到
  app.post('/api/comments/attachments', { bodyLimit: MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireAuth(req);
    const ct = req.headers['content-type'] ?? '';
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!ct.startsWith('multipart/form-data') || !m) throw httpError(400, '需要 multipart/form-data');
    const boundary = Buffer.from(`--${m[1] ?? m[2]}`);

    // body 已由全局 multipart parser 读成 Buffer（api.ts）
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as any);
    if (!raw.length) throw httpError(400, '空请求体');
    if (raw.length > MAX_ATTACHMENT_BYTES) throw httpError(413, '附件超过 500MB 上限');
    const parts = splitMultipart(raw, boundary);
    const filePart = parts.find((p) => p.filename != null);
    if (!filePart) throw httpError(400, '缺少文件字段');

    const safe = sanitizeFilename(filePart.filename!) || 'unnamed';
    const id = crypto.randomUUID();
    const rel = path.join('attachments', id, safe).split(path.sep).join('/');
    const abs = path.join(mediaDir(), rel);
    await ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, filePart.data);

    const row = await prisma.commentAttachment.create({
      data: {
        id,
        filename: safe,
        filePath: rel,
        mime: filePart.contentType || 'application/octet-stream',
        size: BigInt(filePart.data.length),
        uploadedBy: user.id,
      },
    });
    return reply.send({
      attachment: { id: row.id, filename: row.filename, mime: row.mime, size: row.size.toString() },
    });
  });

  // 附件查看/下载：?download=1 强制下载，否则可预览类型 inline
  app.get('/api/comments/attachments/:id', async (req, reply) => {
    const user = await requireAuth(req);
    const { id } = req.params as { id: string };
    const att = await prisma.commentAttachment.findUnique({ where: { id } });
    if (!att) throw httpError(404, '附件不存在');
    // 权限：已绑定批注 → 项目成员可读；未绑定 → 仅上传者本人（草稿阶段）
    if (att.commentId) {
      const comment = await prisma.comment.findUnique({
        where: { id: att.commentId },
        include: { version: { include: { asset: true } } },
      });
      if (!comment) throw httpError(404, '批注不存在');
      await requireMember(user, comment.version.asset.projectId);
    } else if (att.uploadedBy !== user.id) {
      throw httpError(403, '无权访问该附件');
    }

    const abs = path.join(mediaDir(), att.filePath);
    if (!await fsp.stat(abs).then((s) => s.isFile()).catch(() => false)) {
      throw httpError(404, '文件不存在');
    }
    const download = (req.query as any).download === '1';
    const disposition = download || !INLINE_MIMES.has(att.mime) ? 'attachment' : 'inline';
    reply.header('content-type', att.mime);
    reply.header('content-disposition',
      `${disposition}; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
    return reply.sendFile(att.filePath, mediaDir(), { maxAge: '1h', cacheControl: true, acceptRanges: true });
  });
}

/* ---------------- multipart 手工解析 ---------------- */

interface Part { name: string; filename?: string; contentType?: string; data: Buffer }

function splitMultipart(body: Buffer, boundary: Buffer): Part[] {
  const parts: Part[] = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const lineEnd = pos + boundary.length;
    // 结束边界 "--boundary--"
    if (body.slice(lineEnd, lineEnd + 2).toString() === '--') break;
    const headStart = body.indexOf(Buffer.from('\r\n'), lineEnd) + 2;
    const headEnd = body.indexOf(Buffer.from('\r\n\r\n'), headStart);
    if (headEnd === -1) break;
    const head = body.slice(headStart, headEnd).toString();
    const next = body.indexOf(boundary, headEnd + 4);
    if (next === -1) break;
    // 数据到下一个边界前的 \r\n
    const data = body.slice(headEnd + 4, next - 2);
    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    const ctM = /content-type:\s*([^\r\n]+)/i.exec(head);
    parts.push({
      name: nameM?.[1] ?? '',
      filename: fileM?.[1] || undefined,
      contentType: ctM?.[1]?.trim(),
      data,
    });
    pos = next;
  }
  return parts;
}
