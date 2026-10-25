import type { DrawingShape, Drawing } from '@frametalk/shared';

/** 把归一化形状画到 2D canvas（PDF 截图导出用，与 Konva 叠加层几何一致） */
export function drawShapesToCanvas(ctx: CanvasRenderingContext2D, drawing: Drawing, w: number, h: number) {
  for (const s of drawing.shapes) drawShape(ctx, s, w, h);
}

export function drawShape(ctx: CanvasRenderingContext2D, s: DrawingShape, w: number, h: number) {
  ctx.save();
  const sw = (s as { w?: number }).w;
  ctx.lineWidth = Math.max(2, sw != null ? sw * h : h * 0.004);
  ctx.strokeStyle = (s as { color?: string }).color ?? '#ff3b30';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 2;

  if (s.t === 'pen') {
    const pts = s.pts;
    ctx.beginPath();
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = (pts[i] ?? 0) * w;
      const y = (pts[i + 1] ?? 0) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (s.t === 'arrow') {
    const x1 = s.pts[0] ?? 0, y1 = s.pts[1] ?? 0, x2 = s.pts[2] ?? 0, y2 = s.pts[3] ?? 0;
    arrow(ctx, x1 * w, y1 * h, x2 * w, y2 * h, ctx.lineWidth);
  } else if (s.t === 'rect') {
    const x1 = s.pts[0] ?? 0, y1 = s.pts[1] ?? 0, x2 = s.pts[2] ?? 0, y2 = s.pts[3] ?? 0;
    ctx.strokeRect(Math.min(x1, x2) * w, Math.min(y1, y2) * h, Math.abs(x2 - x1) * w, Math.abs(y2 - y1) * h);
  } else if (s.t === 'text') {
    ctx.font = `${Math.max(12, s.size * h)}px sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(s.text, s.x * w, s.y * h);
  }
  ctx.restore();
}

function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) {
  const head = Math.max(8, lw * 3);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

export const DRAW_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#4f7cff', '#ffffff', '#000000'];
