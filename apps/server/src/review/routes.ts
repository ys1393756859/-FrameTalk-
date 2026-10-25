import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAuth, requireProjectRole, httpError } from '../auth/guards.js';
import { createCommentSchema, updateCommentSchema, roleAtLeast } from '@frametalk/shared';
import { emitEvent } from '../notify/events.js';
import { queueFeishuNotify } from '../notify/feishu.js';
import { audit } from '../audit.js';
import type { CommentDto, CommentAttachmentDto } from '@frametalk/shared';
import type { Comment, CommentAttachment } from '@prisma/client';

type CommentWithAuthor = Comment & { author: { name: string; title: string | null } }
  & { attachments?: CommentAttachment[] };

function attachmentToDto(a: CommentAttachment): CommentAttachmentDto {
  return { id: a.id, filename: a.filename, mime: a.mime, size: a.size.toString() };
}

function commentToDto(c: CommentWithAuthor): CommentDto {
  return {
    id: c.id,
    versionId: c.versionId,
    parentId: c.parentId,
    authorId: c.authorId,
    authorName: c.author.name,
    authorTitle: c.author.title,
    frameIn: c.frameIn,
    frameOut: c.frameOut,
    body: c.body,
    drawing: c.drawing,
    labels: c.labels,
    mentions: c.mentions,
    attachments: c.attachments ? c.attachments.map(attachmentToDto) : [],
    resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

async function notifyUsers(userIds: string[], type: string, payload: Record<string, unknown>) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await prisma.notification.createMany({
    data: ids.map((userId) => ({ userId, type, payload: payload as any })),
  });
  for (const userId of ids) emitEvent({ type: 'notify', userId, payload: { ...payload, notifyType: type } });
}

async function loadVersion(versionId: string) {
  const version = await prisma.assetVersion.findUnique({
    where: { id: versionId }, include: { asset: true },
  });
  if (!version) throw httpError(404, '版本不存在');
  return version;
}

export async function reviewRoutes(app: FastifyInstance) {
  app.get('/api/versions/:versionId/comments', async (req) => {
    const user = await requireAuth(req);
    const { versionId } = req.params as { versionId: string };
    const version = await loadVersion(versionId);
    await requireProjectRole(user, version.asset.projectId, 'viewer');
    const comments = await prisma.comment.findMany({
      where: { versionId },
      orderBy: [{ frameIn: 'asc' }, { createdAt: 'asc' }],
      include: {
        author: { select: { name: true, title: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });
    return { comments: comments.map(commentToDto) };
  });

  app.post('/api/versions/:versionId/comments', async (req) => {
    const user = await requireAuth(req);
    const { versionId } = req.params as { versionId: string };
    const version = await loadVersion(versionId);
    await requireProjectRole(user, version.asset.projectId, 'reviewer');
    // 批注统一锚定最新版：历史版本批注只读归档（决策 2026-10-24，PLAN.md 第 11 节）
    const latest = await prisma.assetVersion.findFirst({
      where: { assetId: version.assetId }, orderBy: { versionNo: 'desc' }, select: { id: true },
    });
    if (latest && latest.id !== versionId) {
      throw httpError(400, '历史版本批注已归档，请在最新版本上批注');
    }
    const input = createCommentSchema.parse(req.body);

    // 回复：父评论必须存在且属于当前（最新）版本；帧号强制继承父评论
    const parentId = input.parentId ?? null;
    let parentRow: { id: string; parentId: string | null; authorId: string; authorName: string; frameIn: number; frameOut: number | null } | null = null;
    let frameIn: number;
    let frameOut: number | null = input.frameOut ?? null;
    if (parentId) {
      const p = await prisma.comment.findUnique({
        where: { id: parentId },
        select: {
          id: true, versionId: true, parentId: true, authorId: true, frameIn: true, frameOut: true,
          author: { select: { name: true } },
        },
      });
      if (!p) throw httpError(400, '回复的评论不存在或已被删除');
      if (p.versionId !== versionId) throw httpError(400, '只能回复当前版本的批注');
      parentRow = { id: p.id, parentId: p.parentId, authorId: p.authorId, authorName: p.author.name, frameIn: p.frameIn, frameOut: p.frameOut };
      frameIn = p.frameIn;
      frameOut = p.frameOut;
    } else {
      if (input.frameIn == null) throw httpError(400, '缺少帧号');
      frameIn = input.frameIn;
      if (version.frameCount != null && frameIn > version.frameCount) {
        throw httpError(400, `帧号超出范围（总帧数 ${version.frameCount}）`);
      }
      if (frameOut != null && frameOut < frameIn) {
        throw httpError(400, '区间终点帧必须大于等于起点帧');
      }
    }
    if (!input.body && !input.drawing && !(input.attachmentIds ?? []).length) {
      throw httpError(400, parentRow ? '回复需要文字或附件内容' : '批注需要文字、画笔或附件内容');
    }
    // 绑定附件：仅本人上传且未绑定的
    let attachIds: string[] = [];
    if (input.attachmentIds?.length) {
      const rows = await prisma.commentAttachment.findMany({
        where: { id: { in: input.attachmentIds }, commentId: null, uploadedBy: user.id },
        select: { id: true },
      });
      attachIds = rows.map((r) => r.id);
    }
    const comment = await prisma.comment.create({
      data: {
        versionId,
        parentId,
        authorId: user.id,
        frameIn,
        frameOut,
        body: input.body ?? null,
        drawing: (input.drawing as any) ?? undefined,
        labels: input.labels ?? [],
        mentions: input.mentions ?? [],
        attachments: attachIds.length
          ? { connect: attachIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        author: { select: { name: true, title: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });

    // 通知：被 @ 的人 + 项目其他成员（新评论）
    const members = await prisma.projectMember.findMany({
      where: { projectId: version.asset.projectId, userId: { not: user.id } },
      select: { userId: true },
    });
    const payload = {
      projectId: version.asset.projectId,
      assetId: version.assetId, versionId, commentId: comment.id,
      frameIn: comment.frameIn, assetName: version.asset.name, by: user.name,
      ...(parentRow ? { isReply: true, replyTo: parentRow.authorName } : {}),
    };
    await notifyUsers(members.map((m) => m.userId), 'comment', payload);
    // 被 @ 的人收 mention 通知；回复时追加直接父作者与根评论作者（去重、排除自己）
    const mentioned = new Set((input.mentions ?? []).filter((id) => id !== user.id));
    if (parentRow) {
      mentioned.add(parentRow.authorId);
      // 沿 parentId 链找根作者（限深防环）
      let curId: string | null = parentRow.parentId;
      let rootAuthorId: string | null = null;
      const seen = new Set<string>();
      while (curId && !seen.has(curId) && seen.size < 12) {
        seen.add(curId);
        const up = await prisma.comment.findUnique({ where: { id: curId }, select: { parentId: true, authorId: true } });
        if (!up) break;
        rootAuthorId = up.authorId;
        curId = up.parentId;
      }
      if (rootAuthorId) mentioned.add(rootAuthorId);
      mentioned.delete(user.id);
    }
    await notifyUsers([...mentioned], 'mention', payload);

    // 飞书群 @ 通知（异步聚合，见 notify/feishu.ts；失败不影响评论）
    queueFeishuNotify({
      projectId: version.asset.projectId,
      commentId: comment.id,
      kind: parentRow ? 'reply' : 'top',
      dmUserIds: [...mentioned],
      assetId: version.assetId,
      assetName: version.asset.name,
      frameIn: comment.frameIn,
      frameOut: comment.frameOut,
      body: comment.body,
      hasDrawing: !!comment.drawing,
      attachmentCount: attachIds.length,
      authorId: user.id,
      authorName: user.name,
      mentions: comment.mentions,
    });

    emitEvent({ type: 'comment:new', projectId: version.asset.projectId, comment: commentToDto(comment) });
    return { comment: commentToDto(comment) };
  });

  app.patch('/api/comments/:commentId', async (req) => {
    const user = await requireAuth(req);
    const { commentId } = req.params as { commentId: string };
    const comment = await prisma.comment.findUnique({
      where: { id: commentId }, include: { version: { include: { asset: true } } },
    });
    if (!comment) throw httpError(404, '批注不存在');
    const role = await requireProjectRole(user, comment.version.asset.projectId, 'viewer');
    const isAuthor = comment.authorId === user.id;
    const isManager = role === 'manager' || role === 'admin';
    if (!isAuthor && !isManager) throw httpError(403, '只有作者或管理者可以编辑');

    const input = updateCommentSchema.parse(req.body);
    const data: Record<string, unknown> = {};
    if (input.body !== undefined) data.body = input.body;
    if (input.resolved !== undefined) {
      // 标记已解决：审阅及以上角色，或作者本人
      if (!isAuthor && !roleAtLeast(role, 'reviewer')) {
        throw httpError(403, '没有权限标记解决');
      }
      data.resolvedAt = input.resolved ? new Date() : null;
      data.resolvedBy = input.resolved ? user.id : null;
    }
    const updated = await prisma.comment.update({
      where: { id: commentId }, data,
      include: {
        author: { select: { name: true, title: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });
    emitEvent({ type: 'comment:update', projectId: comment.version.asset.projectId, comment: commentToDto(updated) });
    return { comment: commentToDto(updated) };
  });

  app.delete('/api/comments/:commentId', async (req) => {
    const user = await requireAuth(req);
    const { commentId } = req.params as { commentId: string };
    const comment = await prisma.comment.findUnique({
      where: { id: commentId }, include: { version: { include: { asset: true } } },
    });
    if (!comment) throw httpError(404, '批注不存在');
    const role = await requireProjectRole(user, comment.version.asset.projectId, 'viewer');
    if (comment.authorId !== user.id && role !== 'manager' && role !== 'admin') {
      throw httpError(403, '只有作者或管理者可以删除');
    }
    await prisma.comment.delete({ where: { id: commentId } });
    const body = comment.body?.trim();
    const desc = body ? `「${body.length > 24 ? `${body.slice(0, 24)}…` : body}」` : `（画笔批注 · 帧 ${comment.frameIn}）`;
    await audit(user.id, 'comment.delete', `批注${desc} · 素材「${comment.version.asset.name}」`, req.ip, undefined, { type: 'comment', id: commentId });
    emitEvent({ type: 'comment:update', projectId: comment.version.asset.projectId, deleted: { id: commentId, versionId: comment.versionId } });
    return { ok: true };
  });
}
