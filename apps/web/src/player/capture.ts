import type { DraftAttachment } from '../components/CommentAttachments';

/** 前端 canvas 截帧（决策 2026-10-24：一期截 rendition 画质，服务端 ffmpeg 原画质抽帧后置） */

export function captureVideoToCanvas(video: HTMLVideoElement): HTMLCanvasElement | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('截图编码失败'))), type);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function captureVideoFile(video: HTMLVideoElement, filename: string): Promise<boolean> {
  const c = captureVideoToCanvas(video);
  if (!c) return false;
  downloadBlob(await canvasToBlob(c), filename);
  return true;
}

/** 截帧并上传为批注附件（走现有 POST /api/comments/attachments 链路） */
export async function captureToAttachment(video: HTMLVideoElement, filename: string): Promise<DraftAttachment | null> {
  const c = captureVideoToCanvas(video);
  if (!c) return null;
  const blob = await canvasToBlob(c);
  const fd = new FormData();
  fd.append('file', new File([blob], filename, { type: 'image/png' }), filename);
  const res = await fetch('/api/comments/attachments', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const { attachment } = (await res.json()) as { attachment: DraftAttachment };
  return attachment;
}

/** 多版本同帧合成图：2×N 网格 + 每格左上角文字标签 */
export function compositeCaptures(items: { canvas: HTMLCanvasElement; label: string }[], cellW = 960): HTMLCanvasElement | null {
  const first = items[0];
  if (!first) return null;
  const cols = items.length <= 1 ? 1 : 2;
  const rows = Math.ceil(items.length / cols);
  const labelH = 34;
  const cellH = Math.round((cellW * (first.canvas.height || 9)) / (first.canvas.width || 16));
  const out = document.createElement('canvas');
  out.width = cols * cellW;
  out.height = rows * (cellH + labelH);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, out.width, out.height);
  items.forEach((it, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * (cellH + labelH);
    ctx.drawImage(it.canvas, x, y + labelH, cellW, cellH);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(x, y, cellW, labelH);
    ctx.fillStyle = '#fff';
    ctx.font = '18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.label, x + 10, y + labelH / 2);
  });
  return out;
}

export function captureFilename(assetName: string, versionNo: number, timecode: string) {
  return `${assetName}_v${versionNo}_${timecode.replace(/:/g, '-')}.png`;
}
