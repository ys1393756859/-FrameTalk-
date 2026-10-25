import type { Fps } from '@frametalk/shared';
import { framesToTimecode, sourceTimecode } from '@frametalk/shared';

export interface ExportComment {
  id: string;
  authorName: string;
  frameIn: number;
  frameOut: number | null;
  body: string | null;
  labels: string[];
  resolvedAt: string | null;
  createdAt: string;
}

function text(c: ExportComment): string {
  const label = c.labels.length ? `[${c.labels.join('/')}] ` : '';
  const range = c.frameOut != null ? `${c.frameIn}-${c.frameOut}` : String(c.frameIn);
  return `${label}${c.body ?? ''}`.replace(/\r?\n/g, ' ').trim() || `帧 ${range}`;
}

/** 修改清单 CSV */
export function commentsCsv(comments: ExportComment[], fps: Fps, startFrames: number): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = ['#', '时间码', '结束时间码', '帧号', '作者', '标签', '状态', '内容'];
  const lines = [head.join(',')];
  comments.forEach((c, i) => {
    lines.push([
      String(i + 1),
      esc(sourceTimecode(c.frameIn, fps, startFrames)),
      esc(c.frameOut != null ? sourceTimecode(c.frameOut, fps, startFrames) : ''),
      esc(c.frameOut != null ? `${c.frameIn}-${c.frameOut}` : String(c.frameIn)),
      esc(c.authorName),
      esc(c.labels.join('|')),
      esc(c.resolvedAt ? '已解决' : '待处理'),
      esc(text(c)),
    ].join(','));
  });
  return '\uFEFF' + lines.join('\r\n'); // BOM 方便 Excel
}

/**
 * CMX3600 EDL：每条批注一个事件，注释行带批注内容。
 * Resolve 导入后 marker 落在事件入点帧上。
 */
export function commentsEdl(comments: ExportComment[], fps: Fps, startFrames: number, title: string): string {
  const recStartFrames = 3600 * Math.round(fps.num / fps.den); // REC 从 01:00:00:00 起
  const lines = `TITLE: ${title.toUpperCase().replace(/[^\w\u4e00-\u9fa5 ]/g, '_')}`.split('\n');
  lines.push(fps.num === 30000 && fps.den === 1001 || fps.num === 60000 && fps.den === 1001
    ? 'FCM: DROP FRAME' : 'FCM: NON-DROP FRAME');
  comments.forEach((c, i) => {
    const ev = String(i + 1).padStart(3, '0');
    const inF = startFrames + c.frameIn;
    const outF = startFrames + (c.frameOut ?? c.frameIn + 1);
    const srcIn = framesToTimecode(inF, fps);
    const srcOut = framesToTimecode(outF, fps);
    const recIn = framesToTimecode(recStartFrames + c.frameIn, fps);
    const recOut = framesToTimecode(recStartFrames + (c.frameOut ?? c.frameIn + 1), fps);
    lines.push('');
    lines.push(`${ev}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: MARKERS`);
    lines.push(`* COMMENT: ${text(c)} - ${c.authorName}`);
  });
  return lines.join('\r\n') + '\r\n';
}

/** FCP7 XML（Premiere / FCP 标记导入） */
export function commentsFcpXml(
  comments: ExportComment[],
  fps: Fps,
  startFrames: number,
  name: string,
  durationFrames: number,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fpsAttr = `${fps.num}/${fps.den}`;
  const markers = comments.map((c) => {
    const tc = sourceTimecode(c.frameIn, fps, startFrames).replace(';', ':');
    return [
      '<marker>',
      `<name>${esc(tc)} ${esc(c.authorName)}</name>`,
      `<comment>${esc(text(c))}</comment>`,
      `<in>-1</in><out>-1</out>`,
      '</marker>',
    ].join('');
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="seq1">
    <name>${esc(name)}</name>
    <duration>${Math.max(1, durationFrames)}</duration>
    <rate><timebase>${Math.round((fps.num / fps.den) * 1000) / 1000}</timebase><ntsc>${fps.den !== 1 ? 'TRUE' : 'FALSE'}</ntsc></rate>
    ${markers}
    <media><video><format><rate><timebase>${Math.round((fps.num / fps.den) * 1000) / 1000}</timebase></rate></format></video></media>
  </sequence>
</xmeml>`;
}
