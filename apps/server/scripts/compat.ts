/**
 * 兼容矩阵测试（M0）：生成/复用样片 -> 走转码流水线 -> ffprobe 校验。
 * 用法：pnpm --filter @frametalk/server test:compat
 * 需要本机 PATH 中有 ffmpeg/ffprobe；样片输出在 test-assets/compat/。
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseProbe, buildProxyPlan } from '../src/media/pipeline.js';
import { run, ffprobeJson, statSafe } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../../test-assets/compat');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

interface Case {
  name: string;
  /** 样片生成命令的 ffmpeg 参数（输出文件名固定为 {name}.ext） */
  gen: string[];
  /** 校验断言（针对产物 proxy.mp4） */
  expect: { cfrFramesEqual?: boolean; upright?: boolean; hasAudio?: boolean; fps?: string };
  skip?: boolean;
}

const CASES: Case[] = [
  {
    name: 'h264-8bit',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=25:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
    expect: { cfrFramesEqual: true, hasAudio: true, fps: '25/1' },
  },
  {
    name: 'hevc-8bit',
    gen: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=30000/1001:d=4', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'],
    expect: { cfrFramesEqual: true, fps: '30000/1001' },
  },
  {
    name: 'hevc-10bit-hdr-hlg',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=24:d=3',
      '-vf', 'format=yuv420p10le',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    ],
    expect: { cfrFramesEqual: true, fps: '24/1' },
  },
  {
    name: 'vfr-screenrec',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=30:d=4',
      '-vf', 'setpts=N/29/TB', // 制造可变帧率
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vsync', 'vfr',
    ],
    expect: { fps: '30/1' }, // VFR 容许 ±1 帧偏差，不做帧数强校验
  },
  {
    name: 'prores-mov',
    gen: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=25:d=3', '-c:v', 'prores_ks', '-profile:v', '2'],
    expect: { cfrFramesEqual: true, fps: '25/1' },
  },
  {
    name: 'interlaced-1080i50',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:r=50:d=3',
      '-vf', 'tinterlace=interleave_top,format=yuv422p',
      '-r', '25',
      '-c:v', 'mpeg2video', '-b:v', '6M', '-flags', '+ilme+ildct', '-top', '1',
    ],
    expect: { fps: '25/1' }, // 50 场 -> 25 帧隔行；bwdif 后帧数按场对计，不做帧数强校验
  },
  {
    name: 'dnxhd-mxf',
    gen: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:r=25:d=2', '-c:v', 'dnxhd', '-pix_fmt', 'yuv422p', '-b:v', '36M'],
    expect: { cfrFramesEqual: true, fps: '25/1' },
  },
  {
    name: 'vp9-webm',
    gen: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=24:d=3', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40'],
    expect: { cfrFramesEqual: true, fps: '24/1' },
  },
  {
    name: 'vertical-rotated',
    gen: [
      // 生成带 Display Matrix 旋转元数据的竖屏样片（模拟手机拍摄）
      '-f', 'lavfi', '-display_rotation', '90', '-noautorotate',
      '-i', 'testsrc2=size=360x640:r=25:d=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ],
    expect: { cfrFramesEqual: true, fps: '25/1' },
  },
  {
    name: 'no-audio',
    gen: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an'],
    expect: { cfrFramesEqual: true, hasAudio: false, fps: '25/1' },
  },
  {
    name: 'audio-51',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=25:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le',
    ],
    expect: { cfrFramesEqual: true, hasAudio: true, fps: '25/1' }, // 5.1 下混为立体声
  },
  {
    name: 'two-audio-tracks',
    gen: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:r=25:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    ],
    expect: { cfrFramesEqual: true, hasAudio: true, fps: '25/1' },
  },
];

async function countFrames(file: string): Promise<number> {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames', file,
  ]);
  if (code !== 0) throw new Error(stderr.slice(-300));
  return Number(JSON.parse(stdout).streams[0].nb_read_frames);
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const only = process.argv[2];
  const results: { name: string; ok: boolean; note: string }[] = [];

  for (const c of CASES) {
    if (c.skip) continue;
    if (only && !c.name.includes(only)) continue;
    const src = path.join(OUT, `${c.name}.mkv`);
    process.stdout.write(`\n=== ${c.name} ===\n`);
    try {
      if (!(await statSafe(src))) {
        const r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...c.gen, src]);
        if (r.code !== 0) throw new Error(`生成样片失败: ${r.stderr.slice(-300)}`);
      }

      const probe = await ffprobeJson(src);
      const info = parseProbe(probe);
      const srcFrames = await countFrames(src);
      const info2 = parseProbe(probe, srcFrames);

      const plan = buildProxyPlan(info2);
      const proxy = path.join(OUT, `${c.name}.proxy.mp4`);
      const r = await run(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', src, '-map', '0:v:0', ...plan.audioArgs,
        '-vf', plan.filters.join(','), ...plan.videoArgs, proxy,
      ]);
      if (r.code !== 0) throw new Error(`转码失败: ${r.stderr.slice(-400)}`);

      // 校验
      const pp = await ffprobeJson(proxy);
      const pv = pp.streams.find((s: any) => s.codec_type === 'video');
      const pa = pp.streams.find((s: any) => s.codec_type === 'audio');
      const notes: string[] = [];
      let ok = true;

      const gotFps = pv?.avg_frame_rate ?? '?';
      if (c.expect.fps && gotFps !== c.expect.fps) {
        ok = false; notes.push(`帧率 ${gotFps} != ${c.expect.fps}`);
      }
      if (c.expect.cfrFramesEqual) {
        const proxyFrames = await countFrames(proxy);
        if (Math.abs(proxyFrames - srcFrames) > 1) {
          ok = false; notes.push(`帧数 源${srcFrames} != 代理${proxyFrames}`);
        } else notes.push(`帧数一致(${proxyFrames})`);
      }
      if (c.expect.hasAudio === true && !pa) { ok = false; notes.push('应有音轨但代理无声'); }
      if (c.expect.hasAudio === false && pa) { ok = false; notes.push('不应有音轨'); }
      if (pa && (pa.channels ?? 0) > 2) { ok = false; notes.push(`音轨未下混: ${pa.channels}ch`); }
      // 时长容差 1%
      const srcDur = Number(probe.format?.duration ?? 0);
      const outDur = Number(pp.format?.duration ?? 0);
      if (srcDur > 0 && Math.abs(outDur - srcDur) / srcDur > 0.01) {
        ok = false; notes.push(`时长偏差 ${srcDur.toFixed(2)} -> ${outDur.toFixed(2)}`);
      }

      results.push({ name: c.name, ok, note: ok ? notes.join(';') || '通过' : notes.join(';') });
      process.stdout.write(ok ? `  ✔ ${notes.join(';') || '通过'}\n` : `  ✘ ${notes.join(';')}\n`);
    } catch (err) {
      results.push({ name: c.name, ok: false, note: String(err) });
      process.stdout.write(`  ✘ ${String(err)}\n`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 兼容矩阵结果: ${results.length - failed.length}/${results.length} 通过 =====`);
  for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(24)} ${r.note}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
