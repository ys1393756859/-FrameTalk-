/**
 * 时间码换算：帧号 <-> HH:MM:SS:FF（NTSC 丢帧用 HH:MM:SS;FF）。
 * 帧率一律用有理数 fpsNum/fpsDen 表示，禁止用浮点帧率参与换算。
 */

export interface Fps {
  num: number;
  den: number;
}

/** 常见标准帧率（已约分） */
export const STANDARD_FPS: Fps[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48000, den: 1001 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 100, den: 1 },
  { num: 120, den: 1 },
];

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function reduceFps(num: number, den: number): Fps {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** 把任意帧率吸附到容差内最近的标准帧率（VFR 归一、1000/1001 类噪声） */
export function snapFps(num: number, den: number): Fps {
  const value = num / den;
  let best: Fps = reduceFps(num, den);
  let bestDiff = Infinity;
  for (const std of STANDARD_FPS) {
    const diff = Math.abs(std.num / std.den - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = std;
    }
  }
  // 容差 0.5 帧/秒以内才吸附，避免把异常值硬套
  return bestDiff <= 0.5 ? best : reduceFps(num, den);
}

export function isDropFrame(fps: Fps): boolean {
  // 仅 NTSC 29.97 / 59.94（30000/1001、60000/1001）使用丢帧时间码
  return (
    (fps.num === 30000 && fps.den === 1001) ||
    (fps.num === 60000 && fps.den === 1001)
  );
}

export function nominalFps(fps: Fps): number {
  return Math.round(fps.num / fps.den);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/**
 * 总帧数 -> 时间码字符串。
 * 丢帧（SMPTE ST 12-1）：每分钟跳过 dropPerMin 个帧号（29.97 跳 2、59.94 跳 4），
 * 每个整 10 分钟不跳。实际帧数换算到名义（nominal）帧号空间后再拆解为时、分、秒、帧。
 */
export function framesToTimecode(totalFrames: number, fps: Fps): string {
  if (totalFrames < 0) totalFrames = 0;
  const drop = isDropFrame(fps);
  const nf = nominalFps(fps); // 30 / 60
  const dropPerMin = drop ? Math.round(nf * 0.0666667) : 0; // 2 / 4

  let display = totalFrames;
  if (dropPerMin > 0) {
    const min0 = nf * 60;                            // 块首分钟（整十分钟）完整 1800 / 3600 实际帧
    const realPerMin = nf * 60 - dropPerMin;         // 其余每个分钟的实际帧数 1798 / 3596
    const realPer10Min = nf * 600 - dropPerMin * 9;  // 一个 10 分钟块的实际帧数 17982 / 35964
    const blocks = Math.floor(totalFrames / realPer10Min);
    const m10 = totalFrames % realPer10Min;
    if (m10 < min0) {
      display += dropPerMin * 9 * blocks;
    } else {
      const minute = 1 + Math.floor((m10 - min0) / realPerMin);
      display += dropPerMin * (9 * blocks + minute);
    }
  }

  const f = display % nf;
  const totalSecs = Math.floor(display / nf);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}${drop ? ';' : ':'}${pad(f)}`;
}

/** 时间码字符串（支持 ; 或 : 分隔的帧）-> 相对帧号 */
export function timecodeToFrames(tc: string, fps: Fps): number {
  const m = tc.trim().match(/^(\d+):(\d+):(\d+)[;:](\d+)$/);
  if (!m) throw new Error(`invalid timecode: ${tc}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const f = Number(m[4]);
  const nf = nominalFps(fps);
  const drop = isDropFrame(fps);
  const dropPerMin = drop ? Math.round(nf * 0.0666667) : 0;

  const totalMinutes = h * 60 + min;
  let frames = totalMinutes * nf * 60 + s * nf + f;
  if (drop && dropPerMin > 0) {
    frames -= dropPerMin * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

/** 秒（浮点）-> 帧号（四舍五入；用于 mediaTime 等浮点来源） */
export function secondsToFrames(sec: number, fps: Fps): number {
  return Math.round(sec * fps.num / fps.den);
}

/** 帧号 -> 秒（浮点） */
export function framesToSeconds(frames: number, fps: Fps): number {
  return (frames * fps.den) / fps.num;
}

/**
 * 跳转到第 N 帧时给 <video>.currentTime 赋的值：
 * 取该帧显示区间的中点，避免浮点误差落到相邻帧。
 */
export function frameSeekTime(frame: number, fps: Fps): number {
  return ((frame + 0.5) * fps.den) / fps.num;
}

/** 源起始时间码 + 帧号 -> 源时间码显示 */
export function sourceTimecode(frame: number, fps: Fps, startFrames: number): string {
  return framesToTimecode(startFrames + frame, fps);
}

/** 解析 ffprobe 的 "num/den" 字符串 */
export function parseRational(s: string | undefined | null): Fps | null {
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const den = m[2] ? Number(m[2]) : 1;
  if (!den) return null;
  return reduceFps(Number(m[1]), den);
}
