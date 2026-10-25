import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Stage, Layer, Line, Rect, Text as KText, Arrow as KArrow, Group } from 'react-konva';
import Konva from 'konva';
import type { Drawing, DrawingShape } from '@frametalk/shared';
import { DRAW_COLORS } from './shapes';
import { Space, Button, Input, Modal, ColorPicker } from 'antd';
import {
  EditOutlined, ArrowRightOutlined, BorderOutlined, FontSizeOutlined,
  ClearOutlined, HighlightOutlined,
} from '@ant-design/icons';

export type Tool = 'none' | 'pen' | 'arrow' | 'rect' | 'text';

interface Props {
  videoRef: (el: HTMLVideoElement | null) => void;
  src?: string;
  poster?: string;
  displayAspect?: number | null; // width / height
  overlay?: Drawing | null;
  tool: Tool;
  color: string;
  draftShapes: DrawingShape[];
  onSetDraft: (shapes: DrawingShape[]) => void;
  onClickFrame?: () => void;
}

/**
 * 视频舞台：等比缩放塞满容器（扣黑边），画笔坐标按视频画面归一化 0~1 存储。
 */
export default function VideoStage(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState<number | null>(props.displayAspect ?? null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 切集/切版本时画幅可能变化：同步服务端宽高比，否则旧画幅会把新画面拉伸变形（objectFit: fill）
  useEffect(() => {
    setAspect(props.displayAspect ?? null);
  }, [props.displayAspect]);

  // 服务端宽高缺失时回退视频元素真实尺寸；换 src 重新监听
  useEffect(() => {
    const el = videoElRef.current;
    if (!el || props.displayAspect) return;
    const onMeta = () => {
      if (el.videoWidth && el.videoHeight) setAspect(el.videoWidth / el.videoHeight);
    };
    el.addEventListener('loadedmetadata', onMeta);
    if (el.readyState >= 1) onMeta();
    return () => el.removeEventListener('loadedmetadata', onMeta);
  }, [props.src, props.displayAspect]);

  // 视频实际显示区域（letterbox 内的 video rect）
  const fit = useMemo(() => {
    const a = aspect ?? 16 / 9;
    const { w, h } = box;
    if (!w || !h) return { x: 0, y: 0, w: 0, h: 0 };
    let vw = w;
    let vh = vw / a;
    if (vh > h) { vh = h; vw = vh * a; }
    return { x: (w - vw) / 2, y: (h - vh) / 2, w: vw, h: vh };
  }, [box, aspect]);

  /* ---------- Konva 绘制 ---------- */
  const [drawing, setDrawing] = useState<{ pts: number[] } | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  // 文字工具：ant 弹窗输入（替代浏览器原生 prompt）
  const [textDialog, setTextDialog] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState('');

  const norm = (pos: { x: number; y: number }) => ({
    x: Math.min(1, Math.max(0, (pos.x - fit.x) / (fit.w || 1))),
    y: Math.min(1, Math.max(0, (pos.y - fit.y) / (fit.h || 1))),
  });

  const toolCursor = props.tool === 'none' ? 'default' : 'crosshair';

  const handleDown = (e: Konva.KonvaEventObject<PointerEvent | MouseEvent>) => {
    if (props.tool === 'none') { props.onClickFrame?.(); return; }
    const pos = norm(stageRef.current!.getPointerPosition()!);
    if (props.tool === 'pen' || props.tool === 'arrow' || props.tool === 'rect') {
      setDrawing({ pts: [pos.x, pos.y, pos.x, pos.y] });
    } else if (props.tool === 'text') {
      setTextValue('');
      setTextDialog({ x: pos.x, y: pos.y });
    }
  };

  const handleMove = () => {
    if (!drawing) return;
    const pos = norm(stageRef.current!.getPointerPosition()!);
    setDrawing((d) => {
      if (!d) return d;
      if (props.tool === 'pen') return { pts: [...d.pts, pos.x, pos.y] };
      return { pts: [d.pts[0] ?? 0, d.pts[1] ?? 0, pos.x, pos.y] };
    });
  };

  const handleUp = () => {
    if (!drawing) return;
    const pts = drawing.pts;
    const minSize = 0.004;
    const x1 = pts[0] ?? 0, y1 = pts[1] ?? 0, x2 = pts[2] ?? 0, y2 = pts[3] ?? 0;
    let shape: DrawingShape | null = null;
    if (props.tool === 'pen' && pts.length >= 4) {
      shape = { t: 'pen', pts, color: props.color, w: 0.004 };
    } else if (props.tool === 'arrow') {
      if (Math.hypot(x2 - x1, y2 - y1) > minSize) {
        shape = { t: 'arrow', pts: [x1, y1, x2, y2], color: props.color, w: 0.004 };
      }
    } else if (props.tool === 'rect') {
      if (Math.abs(x2 - x1) > minSize && Math.abs(y2 - y1) > minSize) {
        shape = { t: 'rect', pts: [x1, y1, x2, y2], color: props.color, w: 0.004 };
      }
    }
    if (shape) props.onSetDraft([...props.draftShapes, shape]);
    setDrawing(null);
  };

  // Ctrl/⌘+Z 撤回上一步：绘制中取消当前笔画，否则移除最后一个已提交形状；输入框内保留原生文本撤销
  const undoRef = useRef<() => void>(() => {});
  undoRef.current = () => {
    if (drawing) {
      setDrawing(null);
      return;
    }
    if (props.draftShapes.length) props.onSetDraft(props.draftShapes.slice(0, -1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key.toLowerCase() !== 'z' && e.code !== 'KeyZ')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allShapes: DrawingShape[] = [...(props.overlay?.shapes ?? []), ...props.draftShapes];

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000', overflow: 'hidden' }} ref={wrapRef}>
      <video
        ref={(el) => {
          videoElRef.current = el;
          props.videoRef(el);
        }}
        src={props.src}
        poster={props.poster}
        playsInline
        preload="auto"
        crossOrigin="use-credentials"
        style={{
          position: 'absolute', left: fit.x, top: fit.y,
          width: fit.w || '100%', height: fit.h || '100%',
          objectFit: 'fill', background: '#000',
        }}
      />
      {box.w > 0 && fit.w > 0 && (
        <Stage
          ref={stageRef}
          width={box.w}
          height={box.h}
          style={{ position: 'absolute', inset: 0, cursor: toolCursor }}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
        >
          <Layer>
            <Group x={fit.x} y={fit.y} width={fit.w} height={fit.h} clipX={0} clipY={0} clipWidth={fit.w} clipHeight={fit.h}>
              {allShapes.map((s, i) => renderShape(s, i, fit.w, fit.h))}
              {drawing && renderDraft(drawing, props.tool, props.color, fit.w, fit.h)}
            </Group>
          </Layer>
        </Stage>
      )}

      {/* 文字批注输入（替代原生 prompt） */}
      <Modal
        title="输入文字批注"
        open={!!textDialog}
        onCancel={() => setTextDialog(null)}
        onOk={() => {
          const text = textValue.trim();
          if (text && textDialog) {
            props.onSetDraft([...props.draftShapes, {
              t: 'text', x: textDialog.x, y: textDialog.y, text, color: props.color, size: 0.04,
            }]);
          }
          setTextDialog(null);
        }}
        okText="添加"
        cancelText="取消"
        okButtonProps={{ disabled: !textValue.trim() }}
        destroyOnClose
      >
        <Input
          autoFocus
          placeholder="要标注的文字"
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onPressEnter={() => {
            const text = textValue.trim();
            if (text && textDialog) {
              props.onSetDraft([...props.draftShapes, {
                t: 'text', x: textDialog.x, y: textDialog.y, text, color: props.color, size: 0.04,
              }]);
              setTextDialog(null);
            }
          }}
          maxLength={200}
        />
      </Modal>
    </div>
  );
}

function renderShape(s: DrawingShape, i: number, w: number, h: number) {
  const lw = ((s as { w?: number }).w ?? 0.004) * h;
  if (s.t === 'pen') {
    return <Line key={i} points={s.pts.flatMap((v, idx) => (idx % 2 === 0 ? v * w : v * h))} stroke={s.color} strokeWidth={lw} lineCap="round" lineJoin="round" listening={false} shadowColor="rgba(0,0,0,0.6)" shadowBlur={2} />;
  }
  if (s.t === 'arrow') {
    const x1 = s.pts[0] ?? 0, y1 = s.pts[1] ?? 0, x2 = s.pts[2] ?? 0, y2 = s.pts[3] ?? 0;
    return <KArrow key={i} x={x1 * w} y={y1 * h} points={[0, 0, (x2 - x1) * w, (y2 - y1) * h]} stroke={s.color} fill={s.color} strokeWidth={lw} pointerLength={Math.max(8, lw * 3)} pointerWidth={Math.max(6, lw * 2.4)} listening={false} shadowColor="rgba(0,0,0,0.6)" shadowBlur={2} />;
  }
  if (s.t === 'rect') {
    const x1 = s.pts[0] ?? 0, y1 = s.pts[1] ?? 0, x2 = s.pts[2] ?? 0, y2 = s.pts[3] ?? 0;
    return <Rect key={i} x={Math.min(x1, x2) * w} y={Math.min(y1, y2) * h} width={Math.abs(x2 - x1) * w} height={Math.abs(y2 - y1) * h} stroke={s.color} strokeWidth={lw} listening={false} shadowColor="rgba(0,0,0,0.6)" shadowBlur={2} />;
  }
  return <KText key={i} x={s.x * w} y={s.y * h - 0.002 * h} text={s.text} fill={s.color} fontSize={Math.max(12, s.size * h)} listening={false} shadowColor="rgba(0,0,0,0.6)" shadowBlur={2} />;
}

function renderDraft(d: { pts: number[] }, tool: Tool, color: string, w: number, h: number) {
  const pts = d.pts.flatMap((v, idx) => (idx % 2 === 0 ? v * w : v * h));
  const x1 = pts[0] ?? 0, y1 = pts[1] ?? 0, x2 = pts[2] ?? 0, y2 = pts[3] ?? 0;
  if (tool === 'pen') return <Line points={pts} stroke={color} strokeWidth={0.004 * h} lineCap="round" lineJoin="round" listening={false} />;
  if (tool === 'arrow') return <KArrow x={x1} y={y1} points={[0, 0, x2 - x1, y2 - y1]} stroke={color} fill={color} strokeWidth={0.004 * h} pointerLength={12} pointerWidth={9} listening={false} />;
  return <Rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} stroke={color} strokeWidth={0.004 * h} listening={false} />;
}

/** 带颜色气泡的工具按钮：点击选中工具并弹出调色板（固定色 + 色盘） */
type ColorTool = 'pen' | 'arrow' | 'rect';

export function ToolBar({
  tool, setTool, color, setColor, onClear, disabled,
}: {
  tool: Tool; setTool: (t: Tool) => void; color: string; setColor: (c: string) => void;
  onClear: () => void; disabled?: boolean;
}) {
  const [colorPop, setColorPop] = useState<ColorTool | null>(null);

  const colorToolButton = (t: ColorTool, icon: ReactNode, title: string) => (
    <ColorPicker
      key={t}
      open={colorPop === t}
      disabled={disabled}
      placement="top"
      value={color}
      onChange={(c) => setColor(c.toHexString())}
      onOpenChange={(o) => {
        if (o) { setColorPop(t); setTool(t); }
        else setColorPop((cur) => (cur === t ? null : cur));
      }}
      presets={[{ label: '固定色', colors: DRAW_COLORS }]}
    >
      <Button
        size="small" type={tool === t ? 'primary' : 'text'} disabled={disabled} title={title}
        icon={(
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            {icon}
            <i style={{ position: 'absolute', right: -3, bottom: -3, width: 6, height: 6, borderRadius: '50%', background: color, border: '1px solid rgba(140,140,140,0.9)' }} />
          </span>
        )}
      />
    </ColorPicker>
  );

  return (
    <Space size={4}>
      <Button size="small" type={tool === 'none' ? 'primary' : 'text'} icon={<HighlightOutlined />} onClick={() => setTool('none')} title="选择/关闭画笔" />
      {colorToolButton('pen', <EditOutlined />, '画笔（点击选颜色）')}
      {colorToolButton('arrow', <ArrowRightOutlined />, '箭头（点击选颜色）')}
      {colorToolButton('rect', <BorderOutlined />, '矩形（点击选颜色）')}
      <Button size="small" type={tool === 'text' ? 'primary' : 'text'} icon={<FontSizeOutlined />} disabled={disabled} onClick={() => setTool('text')} title="文字" />
      <Button size="small" icon={<ClearOutlined />} onClick={onClear} title="清空当前画笔" />
    </Space>
  );
}
