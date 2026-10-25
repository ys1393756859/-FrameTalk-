import { describe, it, expect } from 'vitest';
import {
  framesToTimecode,
  timecodeToFrames,
  frameSeekTime,
  secondsToFrames,
  snapFps,
  parseRational,
  reduceFps,
  isDropFrame,
} from '../src/index.js';

const F2997 = { num: 30000, den: 1001 };
const F5994 = { num: 60000, den: 1001 };
const F2398 = { num: 24000, den: 1001 };
const F25 = { num: 25, den: 1 };
const F50 = { num: 50, den: 1 };
const F30 = { num: 30, den: 1 };
const F24 = { num: 24, den: 1 };

describe('framesToTimecode 基础', () => {
  it('整帧率', () => {
    expect(framesToTimecode(0, F25)).toBe('00:00:00:00');
    expect(framesToTimecode(24, F25)).toBe('00:00:00:24');
    expect(framesToTimecode(25, F25)).toBe('00:00:01:00');
    expect(framesToTimecode(1499, F25)).toBe('00:00:59:24');
    expect(framesToTimecode(1500, F25)).toBe('00:01:00:00');
    expect(framesToTimecode(90000 + 10, F25)).toBe('01:00:00:10');
    expect(framesToTimecode(3600, F24)).toBe('00:02:30:00');
    expect(framesToTimecode(107892, F30)).toBe('00:59:56:12');
    expect(framesToTimecode(108000, F30)).toBe('01:00:00:00');
  });

  it('NDF 帧率（23.976 用 24 计数显示）', () => {
    expect(framesToTimecode(0, F2398)).toBe('00:00:00:00');
    expect(framesToTimecode(24, F2398)).toBe('00:00:01:00');
    expect(framesToTimecode(23, F2398)).toBe('00:00:00:23');
  });
});

describe('29.97 丢帧', () => {
  it('前 1 分钟不丢', () => {
    expect(framesToTimecode(0, F2997)).toBe('00:00:00;00');
    expect(framesToTimecode(29, F2997)).toBe('00:00:00;29');
    expect(framesToTimecode(1797, F2997)).toBe('00:00:59;27');
  });
  it('分钟 0 完整 1800 帧；第 1 分钟起点 00:01:00;02', () => {
    expect(framesToTimecode(1798, F2997)).toBe('00:00:59;28');
    expect(framesToTimecode(1799, F2997)).toBe('00:00:59;29');
    expect(framesToTimecode(1800, F2997)).toBe('00:01:00;02');
    expect(framesToTimecode(1801, F2997)).toBe('00:01:00;03');
  });
  it('第 9 分钟之后到第 10 分钟不丢：00:09:59;29 -> 00:10:00;00', () => {
    expect(framesToTimecode(17982 - 1, F2997)).toBe('00:09:59;29');
    expect(framesToTimecode(17982, F2997)).toBe('00:10:00;00');
    expect(framesToTimecode(17982 + 1, F2997)).toBe('00:10:00;01');
    expect(framesToTimecode(17982 + 1800, F2997)).toBe('00:11:00;02');
  });
  it('往返一致（采样大量点）', () => {
    for (let f = 0; f < 20000; f += 7) {
      const tc = framesToTimecode(f, F2997);
      expect(timecodeToFrames(tc, F2997)).toBe(f);
    }
  });
});

describe('59.94 丢帧（每分钟丢 4 帧）', () => {
  it('第 1 分钟起点跳过 ;00-;03', () => {
    expect(framesToTimecode(0, F5994)).toBe('00:00:00;00');
    expect(framesToTimecode(59, F5994)).toBe('00:00:00;59');
    expect(framesToTimecode(3598, F5994)).toBe('00:00:59;58');
    expect(framesToTimecode(3600, F5994)).toBe('00:01:00;04');
  });
  it('10 分钟边界', () => {
    expect(framesToTimecode(35964, F5994)).toBe('00:10:00;00');
  });
  it('往返一致', () => {
    for (let f = 0; f < 40000; f += 13) {
      expect(timecodeToFrames(framesToTimecode(f, F5994), F5994)).toBe(f);
    }
  });
});

describe('非丢帧帧率往返', () => {
  it.each([
    [F25],
    [F50],
    [F24],
    [F30],
    [F2398],
  ])('%j 往返', (fps) => {
    for (let f = 0; f < 5000; f += 11) {
      const tc = framesToTimecode(f, fps);
      expect(timecodeToFrames(tc, fps)).toBe(f);
    }
  });
});

describe('帧号/秒换算与 seek 中点', () => {
  it('secondsToFrames / frameSeekTime', () => {
    expect(secondsToFrames(1.001, F2398)).toBe(24);
    expect(frameSeekTime(0, F25)).toBe(0.02);
    expect(frameSeekTime(100, F2997)).toBeCloseTo((100.5 * 1001) / 30000, 12);
  });
  it('frameSeekTime 落在帧显示区间内', () => {
    const fps = F2997;
    for (let f = 0; f < 300; f++) {
      const t = frameSeekTime(f, fps);
      const frameDur = fps.den / fps.num;
      expect(t).toBeGreaterThanOrEqual(f * frameDur);
      expect(t).toBeLessThan((f + 1) * frameDur);
    }
  });
});

describe('parseRational / snapFps / reduceFps', () => {
  it('parseRational', () => {
    expect(parseRational('30000/1001')).toEqual(F2997);
    expect(parseRational('25/1')).toEqual(F25);
    expect(parseRational('30')).toEqual(F30);
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('abc')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });
  it('snapFps：1000/1001 之类的抖动吸附到 25', () => {
    expect(snapFps(25000, 1001)).toEqual(F25);
    expect(snapFps(30000, 1001)).toEqual(F2997);
    expect(snapFps(59940, 1000)).toEqual(F5994);
    expect(snapFps(23976, 1000)).toEqual(F2398);
  });
  it('snapFps：离标准太远则只约分', () => {
    expect(snapFps(37, 1)).toEqual({ num: 37, den: 1 });
  });
  it('reduceFps', () => {
    expect(reduceFps(60000, 2002)).toEqual(F2997);
  });
  it('isDropFrame', () => {
    expect(isDropFrame(F2997)).toBe(true);
    expect(isDropFrame(F5994)).toBe(true);
    expect(isDropFrame(F25)).toBe(false);
    expect(isDropFrame(F2398)).toBe(false);
  });
});
