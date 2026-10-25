import { useEffect, useRef, useState } from 'react';
import { framesToTimecode, sourceTimecode, type Fps } from '@frametalk/shared';
import type { CommentDto } from '@frametalk/shared';

interface Props {
  player: { currentFrame: number; inFrame: number | null; outFrame: number | null; seekFrame: (n: number) => void };
  fps: Fps;
  frameCount: number | null;
  durationSec: number | null;
  startFrames: number;
  sprite?: { intervalSec: number; cols: number; rows: number; thumbW: number; count: number } | null;
  spriteUrl?: string;
  posterUrl?: string;
  waveformUrl?: string;
  comments: CommentDto[];
  activeCommentId?: string | null;
}

export default function Timeline(p: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);
  const totalFrames = p.frameCount ?? Math.max(1, Math.round((p.durationSec ?? 1) * p.fps.num / p.fps.den));

  useEffect(() => {
    if (!p.waveformUrl) return;
    let alive = true;
    fetch(p.waveformUrl).then((r) => r.json()).then((d) => { if (alive) setPeaks(d.peaks ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [p.waveformUrl]);

  useEffect(() => {
    const c = waveCanvas.current;
    if (!c || !peaks?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#4f7cff88';
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const idx = Math.floor((x / w) * peaks.length);
      const v = peaks[Math.min(peaks.length - 1, idx)] ?? 0;
      const bar = Math.max(1, v * (h / 2 - 2));
      ctx.fillRect(x, mid - bar, 1, bar * 2);
    }
  }, [peaks, hoverX]);

  const xToFrame = (clientX: number) => {
    const el = stripRef.current!;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (totalFrames - 1));
  };

  const pct = (f: number) => `${(f / Math.max(1, totalFrames - 1)) * 100}%`;
  const playPct = pct(p.player.currentFrame);

  const hoverFrame = hoverX != null ? xToFrame(hoverX) : null;
  const hoverThumb = (() => {
    if (hoverFrame == null || !p.sprite || !p.spriteUrl) return null;
    const sec = (hoverFrame * p.fps.den) / p.fps.num;
    const idx = Math.min(p.sprite.count - 1, Math.floor(sec / p.sprite.intervalSec));
    const col = idx % p.sprite.cols;
    const row = Math.floor(idx / p.sprite.cols);
    return { idx, x: col, y: row, w: p.sprite.thumbW };
  })();

  return (
    <div style={{ padding: '0 12px 10px', flexShrink: 0 }}>
      {/* 雪碧图缩略条 */}
      {p.spriteUrl && p.sprite && (
        <div
          ref={stripRef}
          data-testid="timeline-strip"
          style={{
            position: 'relative', height: 44, overflow: 'hidden', borderRadius: 4,
            background: '#1f1f1f', cursor: 'pointer', marginBottom: 4,
          }}
          onPointerDown={(e) => { p.player.seekFrame(xToFrame(e.clientX)); }}
          onPointerMove={(e) => {
            setHoverX(e.clientX);
            if (e.buttons === 1) p.player.seekFrame(xToFrame(e.clientX));
          }}
          onPointerLeave={() => setHoverX(null)}
        >
          <div
            style={{
              position: 'absolute', top: 0, left: 0, height: '100%', width: '100%',
              backgroundImage: p.posterUrl ? `url(${p.posterUrl})` : undefined,
              backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x',
              filter: 'brightness(0.5) saturate(0.8)', opacity: 0.6,
            }}
          />
          {/* 播放头 */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: playPct, width: 2, background: '#ff3b30', boxShadow: '0 0 4px rgba(255,59,48,0.8)', zIndex: 3 }} />
          {/* 批注标记：竖线 + 顶部圆点，贯穿缩略条保证醒目 */}
          {p.comments.map((c) => {
            const urgent = (c.labels ?? []).includes('urgent');
            const active = c.id === p.activeCommentId;
            const color = active ? '#ffc53d' : urgent ? '#ff4d4f' : '#4f9dff';
            const dim = !!c.resolvedAt && !active;
            return (
              <div
                key={c.id}
                className="comment-marker"
                title={`${c.authorName}${urgent ? '［紧急］' : ''}${c.resolvedAt ? '［已解决］' : ''}: ${c.body ?? '画笔批注'}`}
                onClick={(e) => { e.stopPropagation(); p.player.seekFrame(c.frameIn); }}
                style={{
                  position: 'absolute', top: 0, bottom: 0, left: pct(c.frameIn),
                  width: 12, transform: 'translateX(-50%)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  cursor: 'pointer', zIndex: 2,
                }}
              >
                {/* 顶部圆点：白描边保证任何底色上可见 */}
                <span className="marker-dot" style={{
                  marginTop: 3, width: active ? 12 : 9, height: active ? 12 : 9,
                  borderRadius: '50%',
                  background: dim ? 'transparent' : color,
                  border: dim ? '2px solid #52c41a' : '2px solid #fff',
                  boxSizing: 'border-box',
                  opacity: dim ? 0.75 : 1,
                  boxShadow: active ? '0 0 6px rgba(255,197,61,0.9)' : '0 1px 2px rgba(0,0,0,0.5)',
                  transition: 'all .12s',
                }} />
                {/* 贯穿竖线 */}
                <span style={{
                  width: active ? 3 : 2, flex: 1,
                  background: dim
                    ? 'repeating-linear-gradient(180deg,#52c41a 0 3px,transparent 3px 6px)'
                    : color,
                  opacity: dim ? 0.6 : 0.9,
                  boxShadow: '0 0 2px rgba(0,0,0,0.6)',
                }} />
              </div>
            );
          })}
          {/* I/O 区间 */}
          {p.player.inFrame != null && p.player.outFrame != null && (
            <div style={{
              position: 'absolute', top: 0, height: 4,
              left: pct(p.player.inFrame),
              width: `calc(${(p.player.outFrame - p.player.inFrame) / Math.max(1, totalFrames - 1) * 100}%)`,
              background: '#ffcc00',
            }} />
          )}
          {/* 悬停缩略图预览 */}
          {hoverThumb && (
            <div style={{
              position: 'absolute', bottom: 50, left: `min(max(0px, calc(${pct(hoverFrame!)} - 80px)), calc(100% - 160px))`,
              width: 160, height: 90, background: '#000', border: '1px solid #333',
              backgroundImage: `url(${p.spriteUrl})`,
              backgroundSize: `${p.sprite!.cols * 160}px ${p.sprite!.rows * 90}px`,
              backgroundPosition: `-${hoverThumb.x * 160}px -${hoverThumb.y * 90}px`,
              pointerEvents: 'none', zIndex: 2,
            }} />
          )}
        </div>
      )}

      {/* 波形 */}
      <div style={{ display: 'flex', height: 34, gap: 4 }}>
        <canvas ref={waveCanvas} style={{ flex: 1, height: 34, background: '#1a1a1a', borderRadius: 4, cursor: 'pointer' }}
          onPointerDown={(e) => {
            const el = e.currentTarget;
            const rect = el.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            p.player.seekFrame(Math.round(ratio * (totalFrames - 1)));
          }}
        />
      </div>

      {/* 时间码 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#aaa', marginTop: 4, fontFamily: 'monospace' }}>
        <span>
          <span style={{ color: '#fff', fontSize: 14 }}>{sourceTimecode(p.player.currentFrame, p.fps, p.startFrames)}</span>
          {p.player.inFrame != null && <span style={{ marginLeft: 12 }}>I {framesToTimecode(p.startFrames + p.player.inFrame, p.fps)}</span>}
          {p.player.outFrame != null && <span style={{ marginLeft: 12 }}>O {framesToTimecode(p.startFrames + p.player.outFrame, p.fps)}</span>}
        </span>
        <span>帧 <span className="frame-counter">{p.player.currentFrame}</span> / {totalFrames - 1} · {p.fps.num}/{p.fps.den}fps{p.startFrames > 0 ? ' · 源起始 TC ' + framesToTimecode(p.startFrames, p.fps) : ''}</span>
      </div>
    </div>
  );
}
