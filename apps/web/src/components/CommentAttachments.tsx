import { useRef, useState } from 'react';
import { App, Button, List, Tag, Tooltip } from 'antd';
import {
  PaperClipOutlined, FileImageOutlined, VideoCameraOutlined, FileTextOutlined,
  DownloadOutlined, EyeOutlined,
} from '@ant-design/icons';
import type { CommentAttachmentDto } from '@frametalk/shared';

export function attachmentIcon(mime: string) {
  if (mime.startsWith('image/')) return <FileImageOutlined />;
  if (mime.startsWith('video/')) return <VideoCameraOutlined />;
  return <FileTextOutlined />;
}

export function attachmentUrl(a: CommentAttachmentDto, download: boolean) {
  return `/api/comments/attachments/${a.id}${download ? '?download=1' : ''}`;
}

export function kindOf(mime: string): 'image' | 'video' | 'doc' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'doc';
}

/* ---------------- 批注附件上传（输入区） ---------------- */

export function AttachmentPicker({
  files, setFiles, disabled,
}: {
  files: DraftAttachment[];
  setFiles: (f: DraftAttachment[]) => void;
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = async (fl: FileList | null) => {
    if (!fl?.length) return;
    const next: DraftAttachment[] = [...files];
    for (const file of Array.from(fl)) {
      if (file.size > 500 * 1024 * 1024) {
        message.error(`${file.name} 超过 500MB 上限`);
        continue;
      }
      const fd = new FormData();
      fd.append('file', file, file.name);
      try {
        const res = await fetch('/api/comments/attachments', {
          method: 'POST', body: fd, credentials: 'same-origin',
        });
        if (!res.ok) {
          const msg = await res.json().catch(() => `${res.status}`);
          throw new Error(msg.message ?? msg);
        }
        const { attachment } = await res.json() as { attachment: { id: string; filename: string; mime: string; size: string } };
        next.push(attachment);
      } catch (e: any) {
        message.error(`${file.name} 上传失败: ${e.message}`);
      }
    }
    setFiles(next);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Tooltip title="上传附件（图片/视频/文档）">
        <Button
          size="small" type="text" icon={<PaperClipOutlined />} disabled={disabled}
          onClick={() => inputRef.current?.click()}
        />
      </Tooltip>
      <input
        ref={inputRef} type="file" multiple hidden disabled={disabled}
        accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.zip,.rar,.7z"
        onChange={(e) => pick(e.target.files)}
      />
      {files.map((f) => (
        <Tag
          key={f.id} closable={!disabled}
          onClose={(e: any) => { e?.preventDefault?.(); setFiles(files.filter((x) => x.id !== f.id)); }}
          icon={attachmentIcon(f.mime)}
          style={{ maxWidth: 200, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
        >
          {f.filename}
        </Tag>
      ))}
    </div>
  );
}

export interface DraftAttachment {
  id: string;
  filename: string;
  mime: string;
  size: string;
}

/* ---------------- 批注附件展示（列表项）：点击查看 + 下载 ---------------- */

export function CommentAttachments({ attachments }: { attachments: CommentAttachmentDto[] }) {
  const [preview, setPreview] = useState<CommentAttachmentDto | null>(null);

  if (!attachments?.length) return null;
  return (
    <>
      <List
        size="small" split={false}
        dataSource={attachments}
        style={{ marginTop: 6 }}
        renderItem={(a) => (
          <List.Item
            style={{ padding: '2px 0', border: 'none' }}
            actions={[
              <Tooltip key="view" title="查看">
                <Button size="small" type="text" icon={<EyeOutlined />}
                  onClick={(e) => { e.stopPropagation(); setPreview(a); }} />
              </Tooltip>,
              <Tooltip key="dl" title="下载">
                <Button size="small" type="text" icon={<DownloadOutlined />}
                  href={attachmentUrl(a, true)}
                  onClick={(e) => e.stopPropagation()} />
              </Tooltip>,
            ]}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', overflow: 'hidden' }}>
              {attachmentIcon(a.mime)}
              <a
                href={attachmentUrl(a, false)} target="_blank" rel="noreferrer"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPreview(a); }}
                style={{ maxWidth: 180, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
              >{a.filename}</a>
              <span style={{ color: '#666', fontSize: 12 }}>{formatSize(Number(a.size))}</span>
            </span>
          </List.Item>
        )}
      />
      <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function formatSize(n: number): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

/* ---------------- 附件预览弹窗：图片/视频/PDF inline，其余给下载 ---------------- */

function AttachmentPreview({ attachment, onClose }: { attachment: CommentAttachmentDto | null; onClose: () => void }) {
  if (!attachment) return null;
  const kind = kindOf(attachment.mime);
  const url = attachmentUrl(attachment, false);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.72)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#141414', borderRadius: 8, padding: 16, maxWidth: '90vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column', gap: 10, cursor: 'default', border: '1px solid #2a2a2a' }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#ddd' }}>
          {attachmentIcon(attachment.mime)}
          <b style={{ fontSize: 13 }}>{attachment.filename}</b>
          <span style={{ color: '#888', fontSize: 12 }}>{formatSize(Number(attachment.size))}</span>
          <div style={{ flex: 1 }} />
          <Button size="small" type="primary" icon={<DownloadOutlined />} href={attachmentUrl(attachment, true)}>
            下载
          </Button>
        </div>
        <div style={{ overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
          {kind === 'image' && (
            <img src={url} alt={attachment.filename}
              style={{ maxWidth: '84vw', maxHeight: '68vh', objectFit: 'contain', borderRadius: 4 }} />
          )}
          {kind === 'video' && (
            <video src={url} controls autoPlay
              style={{ maxWidth: '84vw', maxHeight: '68vh', borderRadius: 4 }} />
          )}
          {kind === 'doc' && attachment.mime === 'application/pdf' && (
            <iframe src={url} title={attachment.filename}
              style={{ width: '78vw', height: '68vh', border: 'none', borderRadius: 4, background: '#fff' }} />
          )}
          {kind === 'doc' && attachment.mime !== 'application/pdf' && (
            <div style={{ color: '#999', padding: '48px 32px', textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}><FileTextOutlined /></div>
              该格式暂不支持在线预览，请下载后查看
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
