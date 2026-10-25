import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { mediaDir } from '../env.js';
import { ensureDir, ffprobeJson, run, stderrTail, statSafe } from '../util.js';
import { parseProbe, buildProxyPlan, spritePlan, stillFilters, type MediaInfo } from './pipeline.js';
import { parseRational } from '@frametalk/shared';
import { getSetting } from '../admin/settings-service.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface Progress {
  (pct: number, stage: string): void;
}

async function countFrames(file: string): Promise<number> {
  const { code, stdout, stderr } = await run(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=nb_read_frames', file,
  ], { maxBuffer: 200_000 });
  if (code !== 0) throw new Error(`ffprobe 帧数统计失败: ${stderrTail(stderr, 5)}`);
  const n = Number(JSON.parse(stdout)?.streams?.[0]?.nb_read_frames);
  if (!Number.isFinite(n) || n <= 0) throw new Error('无法统计帧数');
  return n;
}

async function firstPtsSeconds(file: string): Promise<number> {
  const { code, stdout } = await run(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-select_streams', 'v:0',
    '-read_intervals', '%+#1', '-show_entries', 'packet=pts_time', file,
  ], { maxBuffer: 200_000 });
  if (code !== 0) return -1;
  const pts = Number(JSON.parse(stdout)?.packets?.[0]?.pts_time);
  return Number.isFinite(pts) ? pts : -1;
}

async function decodeWaveformPeaks(proxyFile: string, buckets = 2000): Promise<number[]> {
  const child = spawn(FFMPEG, [
    '-v', 'quiet', '-i', proxyFile, '-map', '0:a:0',
    '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1',
  ], { windowsHide: true });
  const chunks: Buffer[] = [];
  let total = 0;
  child.stdout.on('data', (d: Buffer) => { chunks.push(d); total += d.length; });
  const stderrTailBuf: string[] = [];
  child.stderr.on('data', (d: Buffer) => { stderrTailBuf.push(d.toString()); });
  const code: number = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new Error(`波形解码失败: ${stderrTailBuf.join('').slice(-1000)}`);

  const pcm = Buffer.concat(chunks, total);
  const samples = new Int16Array(pcm.buffer, 0, Math.floor(total / 2));
  const peaks = new Array<number>(buckets).fill(0);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const start = b * per;
    const end = Math.min(samples.length, start + per);
    for (let i = start; i < end; i += 4) { // 抽样即可，波形只需形状
      const v = Math.abs(samples[i] ?? 0);
      if (v > peak) peak = v;
    }
    peaks[b] = Math.round((peak / 32768) * 1000) / 1000;
  }
  return peaks;
}

export interface TranscodeArtifacts {
  info: MediaInfo;
  proxyRel: string | null; // 无视频轨（纯音频等）时为 null
  posterRel: string | null;
  spriteRel: string | null;
  spriteMeta: object;
  waveformRel: string | null;
  proxyFrames: number | null;
}

/**
 * 对一个版本执行完整转码流水线。输入为 originals/{versionId}/ 内的原片。
 * 通过 onProgress 回调报告 0-100 进度。
 */
export async function transcodeVersion(
  versionId: string,
  originalAbs: string,
  onProgress: Progress,
): Promise<TranscodeArtifacts> {
  const outDir = path.join(mediaDir(), 'renditions', versionId);
  await ensureDir(outDir);
  const rel = (p: string) => path.relative(mediaDir(), p).split(path.sep).join('/');

  onProgress(1, 'probe');
  let probeRaw: any;
  try {
    probeRaw = await ffprobeJson(originalAbs);
  } catch (err) {
    throw new Error(`无法读取媒体信息: ${String(err)}`);
  }

  // 源帧数：nb_frames 缺失时用解码计数
  const preInfo = parseProbe(probeRaw);
  let counted: number | null = null;
  if (preInfo.hasVideo) {
    const v = probeRaw.streams.find((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    if (!v?.nb_frames || Number(v.nb_frames) <= 0) {
      try { counted = await countFrames(originalAbs); } catch { counted = null; }
    }
  }
  const info = parseProbe(probeRaw, counted);

  const writeRendition = async (kind: string, file: string, meta: object | null = null) => {
    const st = await statSafe(file);
    await prisma.rendition.upsert({
      where: { versionId_kind: { versionId, kind } },
      create: { versionId, kind, filePath: rel(file), size: BigInt(st?.size ?? 0), meta: meta ?? undefined },
      update: { filePath: rel(file), size: BigInt(st?.size ?? 0), meta: meta ?? undefined },
    });
  };

  // 纯音频 / 图片 / 其他：M1 不做在线预览
  if (!info.hasVideo) {
    const wave = info.hasAudio ? path.join(outDir, 'waveform.json') : null;
    if (wave) {
      // 纯音频：从原片直接解波形
      const child = spawn(FFMPEG, ['-v', 'quiet', '-i', originalAbs, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      const code = await new Promise<number>((res, rej) => { child.on('error', rej); child.on('close', (c) => res(c ?? -1)); });
      if (code !== 0) throw new Error('音频解码失败');
      const pcm = Buffer.concat(chunks);
      const peaks = bucketPeaks(new Int16Array(pcm.buffer, 0, Math.floor(pcm.length / 2)), 2000);
      await fsp.writeFile(wave, JSON.stringify({ peaks, durationSec: info.durationSec }));
      await writeRendition('waveform', wave, { durationSec: info.durationSec });
    }
    return { info, proxyRel: null, posterRel: null, spriteRel: null, spriteMeta: {}, waveformRel: wave ? rel(wave) : null, proxyFrames: null };
  }

  /* ---------- 1. 代理转码（0-85%） ---------- */
  const proxyAbs = path.join(outDir, 'proxy.mp4');
  const tcSetting = await getSetting<any>('transcode');
  const plan = buildProxyPlan(info, {
    crf: tcSetting.crf,
    maxRateMbps: tcSetting.maxRateMbps,
    preset: tcSetting.preset,
    maxLongSidePx: tcSetting.maxLongSidePx,
  });
  const duration = info.durationSec || 1;
  const args = [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
    '-i', originalAbs,
    '-map', '0:v:0',
    ...plan.audioArgs,
    '-vf', plan.filters.join(','),
    ...plan.videoArgs,
    '-progress', 'pipe:1',
    proxyAbs,
  ];
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    let lastReport = 0;
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 100_000) err = err.slice(-100_000); });
    child.stdout.on('data', (d: Buffer) => {
      const m = d.toString().match(/out_time_us=(\d+)/g);
      const last = m?.[m.length - 1];
      if (m?.length && last) {
        const us = Number(last.split('=')[1]);
        const pct = Math.min(85, 2 + Math.floor((us / 1e6 / duration) * 83));
        const now = Date.now();
        if (pct > lastReport && now - lastReport > 0) { lastReport = pct; onProgress(pct, 'proxy'); }
      }
    });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, stderr: err }));
  });
  if (code !== 0) throw new Error(`ffmpeg 代理转码失败:\n${stderrTail(stderr, 12)}`);
  onProgress(86, 'poster');

  /* ---------- 2. 封面（86%） ---------- */
  const posterAbs = path.join(outDir, 'poster.jpg');
  const posterAt = Math.max(0, duration * 0.1);
  const r1 = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(posterAt), '-i', proxyAbs,
    '-frames:v', '1', '-q:v', '3',
    '-vf', stillFilters(info, "scale='min(iw,1280)':'min(ih,720)':force_original_aspect_ratio=decrease").join(','),
    posterAbs,
  ]);
  if (r1.code !== 0) throw new Error(`封面生成失败:\n${stderrTail(r1.stderr, 8)}`);
  onProgress(88, 'sprite');

  /* ---------- 3. 时间线雪碧图（88-95%） ---------- */
  const sp = spritePlan(info);
  const spriteAbs = path.join(outDir, 'sprite.jpg');
  const r2 = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', proxyAbs,
    '-vf', [...stillFilters(info, `scale=${sp.thumbW}:-2`), `fps=1/${sp.intervalSec}`, `tile=${sp.cols}x${sp.rows}`].join(','),
    '-frames:v', '1', '-q:v', '5',
    spriteAbs,
  ]);
  if (r2.code !== 0) throw new Error(`雪碧图生成失败:\n${stderrTail(r2.stderr, 8)}`);
  onProgress(95, 'waveform');

  /* ---------- 4. 波形（95%） ---------- */
  const waveformAbs = path.join(outDir, 'waveform.json');
  let waveformRel: string | null = null;
  if (info.hasAudio) {
    try {
      const peaks = await decodeWaveformPeaks(proxyAbs);
      await fsp.writeFile(waveformAbs, JSON.stringify({ peaks, durationSec: duration }));
      waveformRel = rel(waveformAbs);
    } catch {
      // 波形失败不阻塞整体
    }
  }
  onProgress(97, 'verify');

  /* ---------- 5. 校验（97-100%） ---------- */
  const proxyProbe = await ffprobeJson(proxyAbs);
  const proxyVideo = proxyProbe.streams.find((s: any) => s.codec_type === 'video');
  const proxyRate = parseRational(proxyVideo?.avg_frame_rate);
  if (!proxyRate || proxyRate.num !== plan.fps.num || proxyRate.den !== plan.fps.den) {
    throw new Error(`代理帧率不符: 期望 ${plan.fps.num}/${plan.fps.den}，实际 ${proxyVideo?.avg_frame_rate}`);
  }
  const pts = await firstPtsSeconds(proxyAbs);
  if (pts < 0 || pts > 0.001) throw new Error(`代理首帧时间戳非 0: ${pts}`);
  const proxyFrames = await countFrames(proxyAbs);

  // 恒定帧率源：代理帧数必须与源一致（±1 容差应对边界估计）
  if (!info.vfr && info.frameCount && Math.abs(proxyFrames - info.frameCount) > 1) {
    throw new Error(`代理帧数与源不一致: 源 ${info.frameCount}，代理 ${proxyFrames}`);
  }
  onProgress(99, 'renditions');

  /* ---------- 6. 写 Rendition 记录 ---------- */
  await writeRendition('proxy', proxyAbs);
  await writeRendition('poster', posterAbs);
  // thumbH 必须从雪碧图实际高度回填（scale=-2 会取偶，无法由源宽高比准确推算）；
  // 写成 null 会让前端按 thumbH 算出的格子高度归零，缩略图糊成一整张拼图
  const sheetProbe = await ffprobeJson(spriteAbs);
  const sheetH = Number(sheetProbe.streams?.[0]?.height ?? 0);
  const spriteMeta = { intervalSec: sp.intervalSec, cols: sp.cols, rows: sp.rows, count: sp.count, thumbW: sp.thumbW, thumbH: sheetH > 0 ? Math.round(sheetH / sp.rows) : null };
  await writeRendition('sprite', spriteAbs, spriteMeta);
  if (waveformRel) await writeRendition('waveform', waveformAbs, { durationSec: duration });

  return { info, proxyRel: rel(proxyAbs), posterRel: rel(posterAbs), spriteRel: rel(spriteAbs), spriteMeta, waveformRel, proxyFrames };
}

function bucketPeaks(samples: Int16Array, buckets: number): number[] {
  const peaks = new Array<number>(buckets).fill(0);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const start = b * per;
    const end = Math.min(samples.length, start + per);
    for (let i = start; i < end; i += 4) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > peak) peak = v;
    }
    peaks[b] = Math.round((peak / 32768) * 1000) / 1000;
  }
  return peaks;
}

export { FFMPEG, FFPROBE };
