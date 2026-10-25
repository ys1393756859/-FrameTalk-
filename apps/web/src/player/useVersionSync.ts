import { useEffect, type RefObject } from 'react';

export interface SyncTarget {
  el: HTMLVideoElement;
  offset: number; // 秒：从属目标时间 = 主版本时间 + offset（片头长度校准）
  attached: boolean; // false = 独立模式，同步引擎跳过
}

/**
 * 主从同步引擎（决策 2026-10-24：按时间码对齐，主版本为基准）：
 * - 镜像主版本的 play / pause / seeked / ratechange 到所有 attached 从属窗口
 * - 播放期间 rAF 持续纠偏：|drift| > 0.5s 直接 seek；0.04~0.5s 用 ±15% 倍速微调平滑收敛
 * - 主版本元素/目标列表通过 ref 提供，hook 本身零依赖重挂载
 */
export function useVersionSync(
  masterRef: RefObject<HTMLVideoElement | null>,
  targetsRef: RefObject<SyncTarget[]>,
) {
  useEffect(() => {
    let raf = 0;
    let m: HTMLVideoElement | null = null;

    const forEach = (fn: (t: SyncTarget) => void) => {
      for (const t of targetsRef.current ?? []) {
        if (t.attached && t.el !== m) fn(t);
      }
    };
    const mirrorSeek = () => forEach((t) => { t.el.currentTime = Math.max(0, m!.currentTime + t.offset); });
    const onPlay = () => forEach((t) => { t.el.playbackRate = m!.playbackRate; t.el.play().catch(() => {}); });
    const onPause = () => forEach((t) => t.el.pause());
    const onRate = () => forEach((t) => { t.el.playbackRate = m!.playbackRate; });

    const detachEl = () => {
      if (!m) return;
      m.removeEventListener('play', onPlay);
      m.removeEventListener('pause', onPause);
      m.removeEventListener('seeked', mirrorSeek);
      m.removeEventListener('ratechange', onRate);
      m = null;
    };
    const attachEl = () => {
      const el = masterRef.current;
      if (!el || el === m) return;
      detachEl();
      m = el;
      m.addEventListener('play', onPlay);
      m.addEventListener('pause', onPause);
      m.addEventListener('seeked', mirrorSeek);
      m.addEventListener('ratechange', onRate);
    };

    const tick = () => {
      attachEl(); // 主版本元素晚挂载/重挂载时自动接线
      if (m && !m.paused) {
        forEach((t) => {
          const target = Math.max(0, m!.currentTime + t.offset);
          const drift = target - t.el.currentTime;
          if (t.el.ended) return; // 从属版本比主版本短：停在结尾不再拽
          if (t.el.paused) { t.el.playbackRate = m!.playbackRate; t.el.play().catch(() => {}); }
          if (Math.abs(drift) > 0.5) {
            t.el.currentTime = target;
            t.el.playbackRate = m!.playbackRate;
          } else if (Math.abs(drift) > 0.04) {
            t.el.playbackRate = m!.playbackRate * Math.min(1.15, Math.max(0.85, 1 + drift * 0.5));
          } else {
            t.el.playbackRate = m!.playbackRate;
          }
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { detachEl(); cancelAnimationFrame(raf); };
  }, [masterRef, targetsRef]);
}
