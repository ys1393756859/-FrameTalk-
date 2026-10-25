import { useCallback, useEffect, useRef, useState } from 'react';
import { frameSeekTime, type Fps } from '@frametalk/shared';

export interface PlayerApi {
  videoRef: (el: HTMLVideoElement | null) => void;
  currentFrame: number;
  playing: boolean;
  rate: number;
  inFrame: number | null;
  outFrame: number | null;
  setInFrame: (f: number | null) => void;
  setOutFrame: (f: number | null) => void;
  seekFrame: (n: number) => void;
  step: (delta: number) => void;
  togglePlay: () => void;
  setRate: (r: number) => void;
  ready: boolean;
  durationSec: number;
}

/**
 * 帧精确播放控制（文档 5.3）：
 * - 帧号 = round(rVFC mediaTime × fpsNum / fpsDen)
 * - 跳第 N 帧 seek 到 (N + 0.5) × fpsDen / fpsNum（帧区间中点，避开浮点边界）
 */
export function usePlayer(fps: Fps, totalFrames: number | null): PlayerApi {
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const rafcId = useRef<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [inFrame, setInFrame] = useState<number | null>(null);
  const [outFrame, setOutFrame] = useState<number | null>(null);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const totalRef = useRef(totalFrames);
  totalRef.current = totalFrames;

  const clampFrame = useCallback((n: number) => {
    const max = totalRef.current ?? Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(max, n));
  }, []);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    videoEl.current = el;
    if (el) el.playbackRate = rate;
  }, [rate]);

  /* 事件接线：play/pause/loadedmetadata/timeupdate(降级) */
  useEffect(() => {
    const el = videoEl.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => {
      setReady(true);
      setDuration(el.duration || 0);
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('loadedmetadata', onMeta);
    if (el.readyState >= 1) onMeta();
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('loadedmetadata', onMeta);
    };
  });

  /* rVFC 循环：呈现帧变化时更新帧号 */
  useEffect(() => {
    const el = videoEl.current;
    if (!el || !('requestVideoFrameCallback' in el)) return;
    const tick = (_: number, meta: any) => {
      const f = fpsRef.current;
      const frame = clampFrame(Math.round(meta.mediaTime * f.num / f.den));
      setCurrentFrame(frame);
      rafcId.current = (el as any).requestVideoFrameCallback(tick);
    };
    rafcId.current = (el as any).requestVideoFrameCallback(tick);
    return () => { if (rafcId.current != null) (el as any).cancelVideoFrameCallback?.(rafcId.current); };
  }, [clampFrame, ready]);

  const onTimeUpdate = useCallback(() => {
    // Firefox 无 rVFC 时的兜底（精度较低，主流浏览器走 rVFC）
    const el = videoEl.current;
    if (!el) return;
    if (typeof (el as HTMLVideoElement).requestVideoFrameCallback !== 'undefined') return;
    const f = fpsRef.current;
    setCurrentFrame(clampFrame(Math.round(el.currentTime * f.num / f.den)));
  }, [clampFrame]);

  useEffect(() => {
    const el = videoEl.current;
    el?.addEventListener('timeupdate', onTimeUpdate);
    return () => el?.removeEventListener('timeupdate', onTimeUpdate);
  }, [onTimeUpdate]);

  const seekFrame = useCallback((n: number) => {
    const el = videoEl.current;
    if (!el) return;
    const f = fpsRef.current;
    const frame = clampFrame(n);
    setCurrentFrame(frame); // 乐观更新，rVFC 会校正
    el.currentTime = frameSeekTime(frame, f);
  }, [clampFrame]);

  const step = useCallback((delta: number) => {
    const el = videoEl.current;
    if (!el) return;
    if (!el.paused) el.pause();
    setCurrentFrame((cf) => {
      const target = clampFrame(cf + delta);
      el.currentTime = frameSeekTime(target, fpsRef.current);
      return target;
    });
  }, [clampFrame]);

  const togglePlay = useCallback(() => {
    const el = videoEl.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);

  /* 键盘快捷键：← → 逐帧，J/K/L 倍速，空格播放暂停，I/O 区间 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      // 图片灯箱（antd 预览，portal 挂在 body 下）打开时，←/→ 归灯箱翻页，播放器不再响应
      const previewWrap = document.querySelector<HTMLElement>('.ant-image-preview-wrap');
      if (previewWrap && previewWrap.style.display !== 'none') return;
      switch (e.key) {
        case 'ArrowLeft': step(-1); e.preventDefault(); break;
        case 'ArrowRight': step(1); e.preventDefault(); break;
        case ' ':
        case 'k':
        case 'K': togglePlay(); e.preventDefault(); break;
        case 'l': case 'L':
          setRate((r) => { const next = r >= 4 ? 4 : r * 2 || 1; applyRate(next); return next; });
          videoEl.current?.play().catch(() => {});
          break;
        case 'j': case 'J':
          setRate((r) => { const next = r <= 0.5 ? 0.5 : r / 2; applyRate(next); return next; });
          break;
        case 'i': case 'I': setInFrame(currentFrameRef.current); break;
        case 'o': case 'O': setOutFrame(currentFrameRef.current); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const currentFrameRef = useRef(0);
  currentFrameRef.current = currentFrame;

  const applyRate = (r: number) => {
    if (videoEl.current) videoEl.current.playbackRate = r;
  };

  useEffect(() => { applyRate(rate); }, [rate]);

  return {
    videoRef, currentFrame, playing, rate, inFrame, outFrame,
    setInFrame, setOutFrame,
    seekFrame, step, togglePlay, setRate, ready,
    durationSec: duration,
  };
}
