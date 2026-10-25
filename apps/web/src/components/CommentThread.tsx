import { useEffect, useMemo, useState } from 'react';
import { Avatar, Button, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons';
import IconAction from './IconAction';
import { CommentAttachments } from './CommentAttachments';
import { MentionInput, type MentionMember } from './MentionInput';
import CollapsibleText from './CollapsibleText';
import { labelColor, labelText } from './LabelPicker';
import {
  sourceTimecode, roleAtLeast,
  type CommentDto, type CommentThread as ThreadData, type CustomLabel, type Fps,
} from '@frametalk/shared';

const TITLE_COLOR: Record<string, string> = { 导演: 'gold', 制片: 'purple', 剪辑: 'cyan', 生成: 'geekblue' };

/** 紧凑时间：到分钟（秒对阅读无意义还占宽，侧栏窄要避免换行） */
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 楼层超过该数量时默认收起，点「展开全部 N 条回复」查看 */
const MAX_VISIBLE_FLOORS = 5;

/**
 * 批注线程卡片（两级楼层式）：楼主 + 平铺楼层 + 内联回复框。
 * 楼层按时间排号（楼主为 1 楼）；回复某一层时显示「回复 @某人」。
 * 「标记解决」只作用于楼主（整线程级）。
 */
export default function CommentThread({
  thread, userId, myRole, canReply, members, fps, startFrames, customLabels,
  activeCommentId, onSelect, onResolve, onDelete, onReply,
}: {
  thread: ThreadData;
  userId: string;
  myRole: any;
  canReply: boolean;
  members: MentionMember[];
  fps: Fps;
  startFrames: number;
  customLabels: CustomLabel[];
  activeCommentId: string | null;
  /** 点击楼主/楼层：选中该评论并 seek 到线程锚定帧 */
  onSelect: (commentId: string, frameIn: number) => void;
  onResolve: (c: CommentDto) => void;
  onDelete: (id: string) => void;
  /** 提交回复；返回是否成功（失败时保留输入框内容） */
  onReply: (target: CommentDto, root: CommentDto, body: string, mentions: string[]) => Promise<boolean>;
}) {
  const { root, floors } = thread;
  const memberNames = useMemo(() => members.map((m) => m.name), [members]);
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyMentions, setReplyMentions] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showAllFloors, setShowAllFloors] = useState(false);

  const visibleFloors = showAllFloors ? floors : floors.slice(0, MAX_VISIBLE_FLOORS);
  // 通知/链接跳转选中了被收起的楼层时自动展开全部楼层
  useEffect(() => {
    if (!activeCommentId || showAllFloors) return;
    if (floors.slice(MAX_VISIBLE_FLOORS).some((fl) => fl.comment.id === activeCommentId)) setShowAllFloors(true);
  }, [activeCommentId, floors, showAllFloors]);
  const canResolve = roleAtLeast(myRole, 'reviewer') || root.authorId === userId;
  const canDelete = (authorId: string) => authorId === userId || roleAtLeast(myRole, 'manager');

  const openReply = (target: CommentDto) => {
    setReplyTo(target);
    setReplyText('');
    setReplyMentions([]);
  };
  const submitReply = async () => {
    if (!replyTo || !replyText.trim() || sending) return;
    setSending(true);
    try {
      const ok = await onReply(replyTo, root, replyText.trim(), replyMentions);
      if (ok) { setReplyText(''); setReplyMentions([]); setReplyTo(null); }
    } finally { setSending(false); }
  };

  return (
    <div style={{ borderBottom: '1px solid #1f1f1f', opacity: root.resolvedAt ? 0.55 : 1 }}>
      {/* ---------- 楼主 ---------- */}
      <div
        data-comment-id={root.id}
        onClick={() => onSelect(root.id, root.frameIn)}
        style={{
          padding: '12px 14px 10px', cursor: 'pointer',
          background: root.id === activeCommentId ? 'rgba(79,124,255,0.10)' : undefined,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Avatar size={22} style={{ background: '#4f7cff', fontSize: 12 }}>{root.authorName[0]}</Avatar>
          <b style={{ fontSize: 13 }}>{root.authorName}</b>
          {root.authorTitle && (
            <Tag color={TITLE_COLOR[root.authorTitle] ?? 'default'}>{root.authorTitle}</Tag>
          )}
          <span style={{ fontFamily: 'monospace', color: '#4f7cff' }}>
            {sourceTimecode(root.frameIn, fps, startFrames)}
            {root.frameOut != null && ` ~ ${sourceTimecode(root.frameOut, fps, startFrames)}`}
          </span>
          <div style={{ flex: 1 }} />
          {root.labels?.map((l: string) => <Tag key={l} color={labelColor(l, customLabels)}>{labelText(l)}</Tag>)}
        </div>
        {root.body && <div style={{ marginTop: 6 }}><CollapsibleText text={root.body} mentionNames={memberNames} /></div>}
        {root.drawing != null && <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>✎ 含画笔</div>}
        <CommentAttachments attachments={root.attachments ?? []} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#666', fontSize: 12, whiteSpace: 'nowrap' }}>
            {fmtTime(root.createdAt)}
            {floors.length > 0 && <span style={{ marginLeft: 8, color: '#8c8c8c' }}>{floors.length} 条回复</span>}
          </span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 'auto', flexShrink: 0 }}>
            {canReply && (
              <Button size="small" type="text" icon={<MessageOutlined />}
                onClick={(e) => { e.stopPropagation(); openReply(root); }}>
                回复
              </Button>
            )}
            {canResolve && (
              <Button size="small" type={root.resolvedAt ? 'default' : 'primary'} ghost icon={<CheckOutlined />}
                onClick={(e) => { e.stopPropagation(); onResolve(root); }}>
                {root.resolvedAt ? '已解决' : '标记解决'}
              </Button>
            )}
            {canDelete(root.authorId) && (
              <IconAction
                icon={<DeleteOutlined />} tooltip="删除批注" danger
                confirm={floors.length ? '删除该批注及其全部回复？' : '删除该批注？'}
                onConfirm={() => onDelete(root.id)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      </div>

      {/* ---------- 楼层区 ---------- */}
      {(floors.length > 0 || replyTo) && (
        <div style={{ margin: '2px 12px 12px 20px', paddingLeft: 10, borderLeft: '2px solid #2a2a2a' }}>
          {visibleFloors.map((f) => {
            const c = f.comment;
            return (
              <div
                key={c.id}
                data-comment-id={c.id}
                onClick={(e) => { e.stopPropagation(); onSelect(c.id, root.frameIn); }}
                style={{
                  padding: '7px 6px', cursor: 'pointer', borderRadius: 4,
                  background: c.id === activeCommentId ? 'rgba(79,124,255,0.10)' : undefined,
                }}
              >
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace', flexShrink: 0 }}>{f.floor}楼</span>
                  <Avatar size={16} style={{ background: '#4f7cff', fontSize: 9, flexShrink: 0 }}>{c.authorName[0]}</Avatar>
                  <b style={{ fontSize: 12 }}>{c.authorName}</b>
                  {c.authorTitle && (
                    <Tag color={TITLE_COLOR[c.authorTitle] ?? 'default'} style={{ fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>
                      {c.authorTitle}
                    </Tag>
                  )}
                  {f.replyToName && (
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>回复 <b style={{ color: '#4f9dff' }}>@{f.replyToName}</b></span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{ color: '#666', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(c.createdAt)}</span>
                  {canReply && (
                    <IconAction
                      icon={<MessageOutlined />} tooltip="回复"
                      onClick={(e) => { e.stopPropagation(); openReply(c); }}
                    />
                  )}
                  {canDelete(c.authorId) && (
                    <IconAction
                      icon={<DeleteOutlined />} tooltip="删除回复" danger
                      confirm="删除该回复？其下级回复将一并删除。"
                      onConfirm={() => onDelete(c.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </div>
                {c.body && (
                  <div style={{ marginTop: 3 }}>
                    <CollapsibleText text={c.body} maxLines={4} fontSize={12} color="#ccc" mentionNames={memberNames} />
                  </div>
                )}
                <CommentAttachments attachments={c.attachments ?? []} />
              </div>
            );
          })}
          {floors.length > MAX_VISIBLE_FLOORS && (
            <Button type="link" size="small" style={{ padding: '2px 0', fontSize: 12 }}
              onClick={(e) => { e.stopPropagation(); setShowAllFloors((v) => !v); }}>
              {showAllFloors ? '收起回复' : `展开全部 ${floors.length} 条回复`}
            </Button>
          )}
          {/* ---------- 内联回复框 ---------- */}
          {replyTo && canReply && (
            <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
              <MentionInput
                value={replyText} onChange={setReplyText}
                mentions={replyMentions} setMentions={setReplyMentions}
                members={members}
                placeholder={`回复 @${replyTo.authorName}...`} rows={2}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                <Button size="small" onClick={() => setReplyTo(null)}>取消</Button>
                <Button size="small" type="primary" loading={sending} disabled={!replyText.trim()}
                  onClick={submitReply}>
                  回复
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
