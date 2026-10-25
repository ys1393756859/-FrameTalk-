import { describe, it, expect } from 'vitest';
import { parseProbe, buildProxyPlan, spritePlan } from '../src/media/pipeline.js';
import { commentsCsv, commentsEdl, commentsFcpXml, type ExportComment } from '../src/export/generators.js';
import { framesToTimecode } from '@frametalk/shared';

function probeFixture(over: Record<string, unknown> = {}) {
  return {
    streams: [
      {
        codec_type: 'video', codec_name: 'h264',
        width: 1920, height: 1080,
        avg_frame_rate: '25/1', r_frame_rate: '25/1',
        field_order: 'progressive', nb_frames: '250',
        duration: '10.0',
        color_transfer: 'bt709', color_primaries: 'bt709',
        disposition: { attached_pic: 0 },
        ...over,
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '10.0', size: '123456' },
  };
}

describe('parseProbe', () => {
  it('常规 1080p25', () => {
    const info = parseProbe(probeFixture());
    expect(info.fps).toEqual({ num: 25, den: 1 });
    expect(info.vfr).toBe(false);
    expect(info.hdr).toBe(false);
    expect(info.frameCount).toBe(250);
    expect(info.displayWidth).toBe(1920);
  });

  it('VFR 手机录屏（r=1000/33 vs avg=30/1）吸附到 30', () => {
    const info = parseProbe(probeFixture({ avg_frame_rate: '1000/33', r_frame_rate: '31000/1001', nb_frames: '' }));
    expect(info.vfr).toBe(true);
    expect(info.fps).toEqual({ num: 30, den: 1 });
  });

  it('29.97 CFR', () => {
    const info = parseProbe(probeFixture({ avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001' }));
    expect(info.fps).toEqual({ num: 30000, den: 1001 });
    expect(info.vfr).toBe(false);
  });

  it('隔行 1080i50：场率 50 但 avg 25，不算 VFR', () => {
    const info = parseProbe(probeFixture({
      avg_frame_rate: '25/1', r_frame_rate: '50/1', field_order: 'tt',
    }));
    expect(info.interlaced).toBe(true);
    expect(info.vfr).toBe(false);
    expect(info.fps).toEqual({ num: 25, den: 1 });
  });

  it('HDR HLG (arib-std-b67)', () => {
    const info = parseProbe(probeFixture({ color_transfer: 'arib-std-b67', color_primaries: 'bt2020' }));
    expect(info.hdr).toBe(true);
  });

  it('旋转元数据 90°：显示宽高对调', () => {
    const info = parseProbe(probeFixture({
      width: 1080, height: 1920,
      side_data_list: [{ rotation: 90 }],
    }));
    expect(info.rotation).toBe(90);
    expect(info.displayWidth).toBe(1920);
    expect(info.displayHeight).toBe(1080);
  });

  it('无视频轨', () => {
    const info = parseProbe({ streams: [{ codec_type: 'audio' }], format: {} });
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
  });
});

describe('buildProxyPlan', () => {
  it('常规：无 bwdif/tonemap，强制 CFR + GOP≈1s', () => {
    const plan = buildProxyPlan(parseProbe(probeFixture()));
    expect(plan.filters.join(',')).not.toContain('bwdif');
    expect(plan.filters.join(',')).not.toContain('zscale');
    expect(plan.filters.join(',')).toContain('scale=');
    expect(plan.videoArgs).toContain('-crf');
    expect(plan.videoArgs).toContain('20');
    expect(plan.videoArgs.join(' ')).toContain('-fps_mode cfr');
    expect(plan.videoArgs.join(' ')).toContain('-r 25/1');
    expect(plan.videoArgs).toContain('+faststart');
    const g = Number(plan.videoArgs[plan.videoArgs.indexOf('-g') + 1]);
    expect(g).toBe(25);
  });

  it('隔行：加 bwdif', () => {
    const plan = buildProxyPlan(parseProbe(probeFixture({ field_order: 'tt', r_frame_rate: '50/1' })));
    expect(plan.filters[0]).toContain('bwdif');
  });

  it('HDR：zscale + tonemap 到 BT.709', () => {
    const plan = buildProxyPlan(parseProbe(probeFixture({ color_transfer: 'arib-std-b67' })));
    const f = plan.filters.join(',');
    expect(f).toContain('zscale=t=linear');
    expect(f).toContain('tonemap=hable');
    expect(f).toContain('bt709');
  });

  it('无音轨：-an', () => {
    const plan = buildProxyPlan(parseProbe({ streams: [probeFixture().streams[0]], format: {} }));
    expect(plan.audioArgs).toEqual(['-an']);
  });

  it('多音轨取第一条下混立体声', () => {
    const plan = buildProxyPlan(parseProbe(probeFixture()));
    expect(plan.audioArgs).toContain('-ac');
    expect(plan.audioArgs).toContain('2');
    expect(plan.audioArgs.join(' ')).toContain('-map 0:a:0?');
  });

  it('小分辨率源保持原尺寸（min 不放大）', () => {
    const plan = buildProxyPlan(parseProbe(probeFixture({ width: 1280, height: 720 })));
    expect(plan.filters.join(',')).toContain("min(iw,1920)");
  });
});

describe('spritePlan', () => {
  it('10 分钟片 -> 5 秒间隔', () => {
    const sp = spritePlan(parseProbe(probeFixture({ duration: '600' })));
    expect(sp.intervalSec).toBe(5);
    expect(sp.count).toBe(120);
    expect(sp.cols * sp.rows).toBeGreaterThanOrEqual(sp.count);
  });
  it('短片段 -> 1 秒间隔', () => {
    const sp = spritePlan(parseProbe(probeFixture({ duration: '20' })));
    expect(sp.intervalSec).toBe(1);
  });
});

describe('导出器', () => {
  const fps = { num: 30000, den: 1001 };
  const comments: ExportComment[] = [
    {
      id: 'c1', authorName: '张三', frameIn: 100, frameOut: null,
      body: '这里偏色', labels: ['urgent'], resolvedAt: null, createdAt: '2026-10-01T10:00:00Z',
    },
    {
      id: 'c2', authorName: '李四', frameIn: 2000, frameOut: 2100,
      body: 'bgm 太响', labels: [], resolvedAt: '2026-10-02T10:00:00Z', createdAt: '2026-10-02T09:00:00Z',
    },
  ];

  it('CSV 带丢帧时间码与 BOM', () => {
    const csv = commentsCsv(comments, fps, 0);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(framesToTimecode(100, fps));
    expect(csv).toContain('这里偏色');
    expect(csv).toContain('已解决');
  });

  it('EDL：事件时间码与源 TC 一致（含起始 TC 偏移）', () => {
    const edl = commentsEdl(comments, fps, 3600 * 30, 'demo'); // 起点 01:00:00:00
    expect(edl).toContain('TITLE:');
    // 帧 100 -> 源TC 01:00:03;10 + 帧 2000
    const tc100 = framesToTimecode(3600 * 30 + 100, fps);
    const tc2000 = framesToTimecode(3600 * 30 + 2000, fps);
    expect(edl).toContain(tc100);
    expect(edl).toContain(tc2000);
    expect(edl).toContain('这里偏色');
  });

  it('FCP XML 结构', () => {
    const xml = commentsFcpXml(comments, fps, 0, 'demo', 3000);
    expect(xml).toContain('<xmeml');
    expect(xml).toContain('<marker>');
    expect((xml.match(/<marker>/g) ?? []).length).toBe(2);
  });
});
