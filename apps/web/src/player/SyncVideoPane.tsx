import { useEffect, useRef, useState } from 'react';
import { Button, InputNumber, Popover, Select, Tag, Tooltip } from 'antd';
import {
  FullscreenOutlined, FullscreenExitOutlined, CameraOutlined, LinkOutlined,
  SoundOutlined, AudioMutedOutlined, AimOutlined, CloseOutlined, SettingOutlined,
} from '@ant-design/icons';
import { frameSeekTime, sourceTimecode, type Fps } from '@frametalk/shared';
import type { VersionDto } from '@frametalk/shared';

export interface SeekRequest {
  frame: number;
  nonce: number;
}

interface Props {
  version: VersionDto;
  fps: Fps;
  offset: number;
  attached: boolean;
  seekRequest: SeekRequest | null;
  /** 返回主版本当前应对齐的播放时间（含 offset），用于挂载/重对齐时定位 */
  getSyncTime: () => number;
  /** 主版本是否正在播放（挂载时决定是否跟随播放） */
  getMasterPlaying: () => boolean;
  registerEl: (el: HTMLVideoElement | null) => void;
  onDetach: () => void;
  onRealign: () => void;
  onClose: () => void;
  onCapture: (video: HTMLVideoElement) => void;
  onLink: (frame: number) => void;
  onOffsetChange: (sec: number) => void;
  versionOptions: { value: string; label: string }[];
  onChangeVersion: (id: string) => void;
  canEdit: boolean;
}

/**
 * 从属对比窗口：纯视频 + 角标 + 操作按钮 + 底部擦洗条。
 * 擦洗条拖动即进入「独立」模式（脱离同步），点「对齐」回归主版本时间线。
 */
export default function SyncVideoPane(props: Props) {
  const { version, fps, attached, seekRequest } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [pos, setPos] = useState(0); // 0~1 播放进度（擦洗条）
  const [muted, setMuted] = useState(true);
  const [isFs, setIsFs] = useState(false);
  const appliedNonce = useRef(0);
  const scrubbing = useRef(false);

  /* rVFC 精确帧号（Firefox 降级 timeupdate） */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const hasRvfc = typeof (el as any).requestVideoFrameCallback === 'function';
    let id: number | null = null;
    if (hasRvfc) {
      const tick = (_: number, meta: any) => {
        setFrame(Math.round((meta.mediaTime * fps.num) / fps.den));
        id = (el as any).requestVideoFrameCallback(tick);
      };
      id = (el as any).requestVideoFrameCallback(tick);
      return () => { if (id != null) (el as any).cancelVideoFrameCallback?.(id); };
    }
    const onTu = () => setFrame(Math.round((el.currentTime * fps.num) / fps.den));
    el.addEventListener('timeupdate', onTu);
    return () => el.removeEventListener('timeupdate', onTu);
  }, [fps.num, fps.den, version.id]);

  const applyPendingSeek = () => {
    const el = videoRef.current;
    if (!el || el.readyState < 1) return false;
    if (seekRequest && seekRequest.nonce !== appliedNonce.current) {
      appliedNonce.current = seekRequest.nonce;
      el.currentTime = frameSeekTime(seekRequest.frame, fps);
      return true;
    }
    return false;
  };

  /* 外部跳帧请求（关联帧/历史批注跳转） */
  useEffect(() => { applyPendingSeek(); }, [seekRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const onLoadedMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    if (!applyPendingSeek() && attached) {
      el.currentTime = Math.max(0, props.getSyncTime());
    }
    if (attached && props.getMasterPlaying()) el.play().catch(() => {});
  };

  const onTimeUpdate = () => {
    const el = videoRef.current;
    if (!el || !el.duration || scrubbing.current) return;
    setPos(el.currentTime / el.duration);
    if (typeof (el as any).requestVideoFrameCallback !== 'function') {
      setFrame(Math.round((el.currentTime * fps.num) / fps.den));
    }
  };

  /* 擦洗条：按下即脱离同步 */
  const scrubTo = (clientX: number, bar: HTMLDivElement) => {
    const el = videoRef.current;
    if (!el || !el.duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
    setPos(ratio);
  };

  const toggleFullscreen = () => {
    const w = wrapRef.current;
    if (!w) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else w.requestFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const offsetStep = fps.den / fps.num; // 1 帧的秒数
  const settingsPanel = (
    <div style={{ width: 210, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#999' }}>同步偏移（从属时间 = 主版本 + 偏移）</div>
      <InputNumber
        size="small" style={{ width: '100%' }} value={props.offset}
        step={offsetStep} precision={3} addonAfter="秒"
        onChange={(v) => props.onOffsetChange(Number(v ?? 0))}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="small" onClick={() => props.onOffsetChange(+(props.offset - offsetStep).toFixed(3))}>−1 帧</Button>
        <Button size="small" onClick={() => props.onOffsetChange(+(props.offset + offsetStep).toFixed(3))}>＋1 帧</Button>
        <Button size="small" onClick={() => props.onOffsetChange(0)}>归零</Button>
      </div>
    </div>
  );

  return (
    <div
      ref={wrapRef}
      data-testid={`sync-pane-${version.id}`}
      style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, background: '#000', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <video
        ref={(el) => { videoRef.current = el; props.registerEl(el); }}
        src={`/api/media/${version.id}/proxy`}
        poster={version.hasPoster ? `/api/media/${version.id}/poster` : undefined}
        playsInline
        preload="auto"
        muted={muted}
        crossOrigin="use-credentials"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        style={{ flex: 1, width: '100%', minHeight: 0, objectFit: 'contain', background: '#000' }}
      />

      {/* 顶部：版本选择 + 角标 | 操作按钮 */}
      <div style={{ position: 'absolute', top: 6, left: 6, right: 6, display: 'flex', gap: 6, alignItems: 'center', zIndex: 5 }}>
        <Select
          size="small" value={version.id} style={{ width: 128 }}
          onChange={props.onChangeVersion}
          options={[{ value: version.id, label: `v${version.versionNo}（当前）` }, ...props.versionOptions]}
        />
        <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>v{version.versionNo} · 对比</Tag>
        {!attached && <Tag color="error" style={{ marginInlineEnd: 0 }}>独立</Tag>}
        <div style={{ flex: 1 }} />
        <Tooltip title={muted ? '开启声音' : '静音'}>
          <Button size="small" type="text" icon={muted ? <AudioMutedOutlined /> : <SoundOutlined />}
            style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }}
            onClick={() => setMuted((m) => !m)} />
        </Tooltip>
        <Popover trigger="click" placement="bottomRight" content={settingsPanel}>
          <Button size="small" type="text" icon={<SettingOutlined />} style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }} />
        </Popover>
        <Tooltip title="对齐到主版本">
          <Button size="small" type={attached ? 'text' : 'primary'} icon={<AimOutlined />}
            style={attached ? { color: '#ccc', background: 'rgba(0,0,0,0.45)' } : undefined}
            onClick={props.onRealign} />
        </Tooltip>
        {props.canEdit && (
          <Tooltip title="与主版本当前帧建立关联">
            <Button size="small" type="text" icon={<LinkOutlined />}
              style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }}
              onClick={() => props.onLink(frame)} />
          </Tooltip>
        )}
        <Tooltip title="截取当前帧（PNG）">
          <Button size="small" type="text" icon={<CameraOutlined />}
            style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }}
            onClick={() => videoRef.current && props.onCapture(videoRef.current)} />
        </Tooltip>
        <Tooltip title={isFs ? '退出全屏' : '全屏查看该版本'}>
          <Button size="small" type="text" icon={isFs ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }}
            onClick={toggleFullscreen} />
        </Tooltip>
        <Tooltip title="移出同屏">
          <Button size="small" type="text" icon={<CloseOutlined />}
            style={{ color: '#ccc', background: 'rgba(0,0,0,0.45)' }}
            onClick={props.onClose} />
        </Tooltip>
      </div>

      {/* 底部：时间码 + 擦洗条 */}
      <div style={{ position: 'absolute', bottom: 14, right: 10, zIndex: 5, fontFamily: 'monospace', fontSize: 12, color: '#fff', textShadow: '0 1px 3px #000', pointerEvents: 'none' }}>
        帧 {frame} · {sourceTimecode(frame, fps, version.startFrames ?? 0)}
      </div>
      <div
        data-testid={`scrub-${version.id}`}
        onPointerDown={(e) => {
          scrubbing.current = true;
          props.onDetach();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrubTo(e.clientX, e.currentTarget as HTMLDivElement);
        }}
        onPointerMove={(e) => { if (scrubbing.current) scrubTo(e.clientX, e.currentTarget as HTMLDivElement); }}
        onPointerUp={() => { scrubbing.current = false; }}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: 'rgba(255,255,255,0.14)', cursor: 'pointer', zIndex: 6 }}
      >
        <div style={{ width: `${pos * 100}%`, height: '100%', background: attached ? '#4f7cff' : '#ff7a45' }} />
      </div>
    </div>
  );
}
