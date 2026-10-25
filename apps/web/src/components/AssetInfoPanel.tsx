import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Collapse, Image, Input, message } from 'antd';
import { EditOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { AssetDto, VersionDto, Fps } from '@frametalk/shared';
import { framesToTimecode } from '@frametalk/shared';
import { api, formatBytes } from '../api';

/* ffprobe 原始输出的最小子集（存于 AssetVersion.probe） */
interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
  bit_rate?: string;
  channels?: number;
  channel_layout?: string;
  r_frame_rate?: string;
}
interface Probe {
  streams?: ProbeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

const KIND_TEXT: Record<string, string> = { video: '视频', audio: '音频', image: '图片', other: '其他' };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid #1f1f1f', fontSize: 13 }}>
      <div style={{ width: 88, color: '#999', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, wordBreak: 'break-all' }}>{children}</div>
    </div>
  );
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 秒 → HH:MM:SS（frameCount 缺失时退而求其次） */
function fmtSecDuration(sec: number): string {
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${p(sec / 3600)}:${p((sec % 3600) / 60)}:${p(sec % 60)}`;
}

function fmtBitrate(bps?: number | string | null): string {
  const n = Number(bps);
  if (!n || !isFinite(n)) return '-';
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(2)} Mbps` : `${(n / 1e3).toFixed(2)} Kbps`;
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

/**
 * 信息 Tab：素材基础信息 + 视频/音频流详情（数据来自 AssetVersion.probe）
 */
export default function AssetInfoPanel({
  asset, version, projectName, canEdit, onSaved,
}: {
  asset: AssetDto;
  version?: VersionDto;
  projectName?: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(asset.description ?? '');
  const [saving, setSaving] = useState(false);

  const probe = (version?.probe ?? {}) as Probe;
  const vStream = probe.streams?.find((s) => s.codec_type === 'video');
  const aStream = probe.streams?.find((s) => s.codec_type === 'audio');
  const sprite = version?.sprite ?? null;
  // 卡片宽高比（宽/高）优先用真实分辨率；sprite meta 的 thumbH 可能为 null（历史数据），必须兜底
  const tileRatio = version?.width && version?.height
    ? version.width / version.height
    : sprite?.thumbW && sprite?.thumbH ? sprite.thumbW / sprite.thumbH : 16 / 9;
  const fps: Fps = { num: version?.fpsNum ?? 25, den: version?.fpsDen ?? 1 };

  // 批量预热帧缩略图缓存（一次 ffmpeg pass 产出全部小图），牌堆翻帧即点即出
  useEffect(() => {
    if (!version || !sprite || sprite.count <= 0) return;
    fetch(`/api/media/${version.id}/frames-batch?w=160`, { credentials: 'include' }).catch(() => {});
  }, [version?.id, sprite?.count]);

  /* ---- 帧缩略图牌堆：叠成一摞只占一张卡片，滚轮/按钮翻帧，点击开灯箱 ---- */
  const frameCount = sprite?.count ?? 0;
  const [frameIdx, setFrameIdx] = useState(0);
  const [preview, setPreview] = useState({ visible: false, current: 0 });
  const deckRef = useRef<HTMLDivElement>(null);

  // 切换素材时回到第一帧
  useEffect(() => { setFrameIdx(0); }, [version?.id]);

  // 滚轮翻帧（passive:false 才能阻止页面跟着滚）
  useEffect(() => {
    const el = deckRef.current;
    if (!el || frameCount <= 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setFrameIdx((i) => (i + (e.deltaY > 0 ? 1 : -1) + frameCount) % frameCount);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [frameCount]);

  // 预载前后相邻帧，翻帧不闪白
  useEffect(() => {
    if (!version || !sprite || frameCount <= 0) return;
    for (const d of [1, -1]) {
      const j = (frameIdx + d + frameCount) % frameCount;
      const im = new window.Image();
      im.src = `/api/media/${version.id}/frame?t=${(j * sprite.intervalSec).toFixed(2)}&w=160`;
    }
  }, [frameIdx, frameCount, version?.id, sprite?.intervalSec]);

  // 灯箱素材列表：封面 + 全部帧（灯箱里直接看全分辨率帧）
  const posterOffset = version?.hasPoster ? 1 : 0;
  const previewItems = useMemo(() => {
    const items: string[] = [];
    if (version?.hasPoster) items.push(`/api/media/${version.id}/poster`);
    if (version && sprite) {
      for (let i = 0; i < sprite.count; i++) {
        items.push(`/api/media/${version.id}/frame?t=${(i * sprite.intervalSec).toFixed(2)}`);
      }
    }
    return items;
  }, [version?.id, version?.hasPoster, sprite?.count, sprite?.intervalSec]);

  // 灯箱关闭后，牌堆顶牌同步到灯箱里最后浏览的那一帧
  useEffect(() => {
    if (preview.visible || frameCount <= 0) return;
    const fi = preview.current - posterOffset;
    if (fi >= 0 && fi < frameCount) setFrameIdx(fi);
  }, [preview.visible]);

  const fpsText = version?.fpsNum && version?.fpsDen
    ? `${+(version.fpsNum / version.fpsDen).toFixed(2)} FPS`
    : vStream?.r_frame_rate ? `${vStream.r_frame_rate} FPS` : '-';

  const durationText = version?.frameCount != null && version.frameCount > 0
    ? framesToTimecode(version.frameCount, fps)
    : version?.durationSec != null ? fmtSecDuration(version.durationSec) : '-';

  const extText = (version?.originalName.split('.').pop() ?? '').toUpperCase()
    || ((probe.format?.format_name ?? '').split(',')[0] ?? '').toUpperCase()
    || '-';

  const aspectText = (() => {
    if (vStream?.display_aspect_ratio && vStream.display_aspect_ratio !== '0:1') return vStream.display_aspect_ratio;
    const w = version?.width ?? vStream?.width;
    const h = version?.height ?? vStream?.height;
    if (w && h) { const g = gcd(w, h) || 1; return `${w / g}:${h / g}`; }
    return '-';
  })();

  const saveDesc = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ description: desc.trim() }) });
      message.success('描述已保存');
      setEditing(false);
      onSaved();
    } catch (e: any) {
      message.error(e?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 14px 16px' }}>
      <div style={{ fontSize: 12, color: '#999', margin: '10px 0 6px' }}>基础信息</div>
      <div style={{ fontSize: 15, fontWeight: 600, wordBreak: 'break-all' }}>
        {version?.originalName ?? asset.name}
      </div>

      {/* 文件描述：可编辑（editor+） */}
      {editing ? (
        <Input.TextArea
          value={desc} onChange={(e) => setDesc(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 5 }} maxLength={2000} autoFocus disabled={saving}
          onBlur={saveDesc}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); saveDesc(); } }}
          placeholder="输入文件描述，Enter 保存"
          style={{ marginTop: 8 }}
        />
      ) : (
        <div
          onClick={() => { if (canEdit) { setDesc(asset.description ?? ''); setEditing(true); } }}
          style={{
            marginTop: 8, fontSize: 13, whiteSpace: 'pre-wrap',
            color: asset.description ? undefined : '#777',
            cursor: canEdit ? 'pointer' : 'default',
          }}
        >
          {asset.description || '点击添加文件描述'}
          {canEdit && asset.description && <EditOutlined style={{ marginLeft: 6, color: '#888', fontSize: 12 }} />}
        </div>
      )}

      {/* 封面图 + 帧缩略图牌堆（同一行）：帧全部叠成一摞只占一张卡片的位置 */}
      {(version?.hasPoster || sprite) && (
        <div style={{ marginTop: 14, display: 'flex', gap: 18, alignItems: 'flex-start' }}>
          {version?.hasPoster && (
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>封面图</div>
              <div
                className="ft-photo-card"
                onClick={() => setPreview({ visible: true, current: 0 })}
                style={{ width: 138, cursor: 'pointer' }}
              >
                <img
                  src={`/api/media/${version.id}/poster`} alt="封面图"
                  style={{
                    width: '100%', aspectRatio: String(tileRatio),
                    objectFit: 'contain', background: '#000', display: 'block', borderRadius: 5,
                  }}
                />
              </div>
            </div>
          )}
          {sprite && version && frameCount > 0 && (
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>
                帧缩略图（{frameCount} 帧 · 滚轮翻帧，点击看灯箱）
              </div>
              <div ref={deckRef} style={{ position: 'relative', width: 138 }}>
                {/* 垫在顶牌下的两张牌背，露出错位边缘体现"一摞"的厚度 */}
                <div className="ft-deck-back" style={{ transform: 'rotate(-5deg) translate(-3px, 5px)' }} />
                <div className="ft-deck-back" style={{ transform: 'rotate(4.5deg) translate(4px, 4px)' }} />
                <div
                  className="ft-photo-card"
                  onClick={() => setPreview({ visible: true, current: posterOffset + frameIdx })}
                  style={{ position: 'relative', zIndex: 1, width: 138, cursor: 'pointer' }}
                >
                  <img
                    key={frameIdx}
                    src={`/api/media/${version.id}/frame?t=${(frameIdx * sprite.intervalSec).toFixed(2)}&w=160`}
                    alt={`帧 ${frameIdx + 1}`}
                    style={{
                      width: '100%', aspectRatio: String(tileRatio),
                      objectFit: 'cover', background: '#1a1a1a', display: 'block', borderRadius: 5,
                    }}
                  />
                  {/* 右上角计数徽标 */}
                  <div style={{
                    position: 'absolute', top: 9, right: 9, pointerEvents: 'none',
                    background: 'rgba(0,0,0,.65)', color: '#ddd', fontSize: 11,
                    padding: '1px 7px', borderRadius: 9, fontVariantNumeric: 'tabular-nums',
                  }}>
                    {frameIdx + 1} / {frameCount}
                  </div>
                  {/* 底部操作条：上一帧 / 时间码 / 下一帧 */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute', left: 5, right: 5, bottom: 5, height: 26,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: 'rgba(0,0,0,.55)', borderRadius: 5, padding: '0 3px',
                    }}
                  >
                    <Button
                      type="text" size="small" icon={<LeftOutlined style={{ fontSize: 11 }} />}
                      onClick={() => setFrameIdx((i) => (i - 1 + frameCount) % frameCount)}
                      style={{ color: '#ccc', minWidth: 22, height: 20 }}
                    />
                    <span style={{ fontSize: 11, color: '#ddd', fontVariantNumeric: 'tabular-nums' }}>
                      {framesToTimecode(Math.round(frameIdx * sprite.intervalSec * fps.num / fps.den), fps)}
                    </span>
                    <Button
                      type="text" size="small" icon={<RightOutlined style={{ fontSize: 11 }} />}
                      onClick={() => setFrameIdx((i) => (i + 1) % frameCount)}
                      style={{ color: '#ccc', minWidth: 22, height: 20 }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* 图片灯箱：封面 + 全部帧可左右翻页、缩放、旋转 */}
          <Image.PreviewGroup
            items={previewItems}
            preview={{
              visible: preview.visible,
              current: preview.current,
              onVisibleChange: (v) => setPreview((p) => ({ ...p, visible: v })),
              onChange: (c) => setPreview((p) => ({ ...p, current: c })),
            }}
          />
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Row label="文件位置">{projectName ?? '-'}</Row>
        <Row label="类型">{KIND_TEXT[asset.kind] ?? asset.kind}</Row>
        <Row label="大小">{version ? formatBytes(version.size) : '-'}</Row>
        <Row label="创建人">{version?.uploadedByName ?? '-'}</Row>
        <Row label="创建时间">{fmtTime(version?.createdAt ?? asset.createdAt)}</Row>
        <Row label="更新人">{version?.uploadedByName ?? '-'}</Row>
        <Row label="更新时间">{fmtTime(version?.updatedAt ?? asset.updatedAt)}</Row>
        <Row label="时长">{durationText}</Row>
        <Row label="文件格式">{extText}</Row>
      </div>

      <Collapse
        ghost size="small" defaultActiveKey={['v', 'a']} style={{ marginTop: 10 }}
        items={[
          {
            key: 'v',
            label: <b style={{ fontSize: 13 }}>视频流 #1</b>,
            children: (
              <div>
                <Row label="分辨率">{version?.width && version?.height ? `${version.width}x${version.height}` : vStream?.width && vStream?.height ? `${vStream.width}x${vStream.height}` : '-'}</Row>
                <Row label="帧率">{fpsText}</Row>
                <Row label="编码格式">{vStream?.codec_name?.toUpperCase() ?? '-'}</Row>
                <Row label="显示宽高比">{aspectText}</Row>
                <Row label="码率/比特率">{fmtBitrate(vStream?.bit_rate ?? probe.format?.bit_rate)}</Row>
              </div>
            ),
          },
          {
            key: 'a',
            label: <b style={{ fontSize: 13 }}>音频流 #1</b>,
            children: aStream ? (
              <div>
                <Row label="编码格式">{aStream.codec_name ?? '-'}</Row>
                <Row label="声道数">{aStream.channels != null ? `${aStream.channels}ch` : '-'}</Row>
                <Row label="声道模式">{aStream.channel_layout ?? '-'}</Row>
                <Row label="码率/比特率">{fmtBitrate(aStream.bit_rate)}</Row>
              </div>
            ) : <div style={{ color: '#777', fontSize: 12 }}>无音频流</div>,
          },
        ]}
      />
    </div>
  );
}
