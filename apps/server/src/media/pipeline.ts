import { parseRational, reduceFps, snapFps, type Fps } from '@frametalk/shared';

/** ffprobe 输出 -> 统一的媒体描述（纯函数，供单测与兼容矩阵脚本复用） */
export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  fps: Fps | null; // 最终采用（吸附后）的帧率
  sourceAvgFps: Fps | null;
  sourceRealFps: Fps | null;
  vfr: boolean; // 可变帧率
  interlaced: boolean;
  hdr: boolean;
  rotation: number; // 度（顺时针），0/90/180/270
  width: number; // 编码尺寸
  height: number;
  displayWidth: number; // 旋转后的显示尺寸
  displayHeight: number;
  frameCount: number | null; // 源帧数（可能为 null，需 count）
  durationSec: number;
  startTimecode: string | null;
  audioStreams: number;
  probe: unknown; // 原始 probe JSON
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const HDR_PRIMARIES = new Set(['bt2020', 'bt2020nc', 'smpte432']);

function streamRotation(stream: any): number {
  const side = stream?.side_data_list;
  if (Array.isArray(side)) {
    for (const s of side) {
      if (s && typeof s.rotation === 'number') {
        // ffprobe 的 rotation 为顺时针显示角度（可为负）
        return ((s.rotation % 360) + 360) % 360;
      }
    }
  }
  // 老版本 ffmpeg 写在 stream 上
  if (typeof stream?.rotation === 'number') return ((stream.rotation % 360) + 360) % 360;
  return 0;
}

export function parseProbe(probe: any, countedFrames?: number | null): MediaInfo {
  const streams: any[] = probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
  const audioStreams = streams.filter((s) => s.codec_type === 'audio').length;
  const format = probe?.format ?? {};
  const durationSec = Number(video?.duration ?? format.duration ?? 0) || 0;

  if (!video) {
    return {
      hasVideo: false, hasAudio: audioStreams > 0, fps: null,
      sourceAvgFps: null, sourceRealFps: null, vfr: false, interlaced: false,
      hdr: false, rotation: 0,
      width: 0, height: 0, displayWidth: 0, displayHeight: 0,
      frameCount: null, durationSec, startTimecode: null,
      audioStreams, probe,
    };
  }

  const avg = parseRational(video.avg_frame_rate);
  const real = parseRational(video.r_frame_rate);
  const fieldOrder = String(video.field_order ?? 'progressive');
  const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(fieldOrder);

  // 隔行流 r_frame_rate 是场率（50i 报 50），平均帧率才是帧率
  let base: Fps;
  if (avg && avg.num > 0) base = avg;
  else if (real && real.num > 0) base = real;
  else base = { num: 25, den: 1 };

  const fps = snapFps(base.num, base.den);
  const vfr = !interlaced && !!real && !!avg && (real.num * avg.den !== avg.num * real.den);

  const rotation = streamRotation(video);
  const swap = rotation === 90 || rotation === 270;
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);

  let frameCount: number | null = null;
  if (typeof countedFrames === 'number') frameCount = countedFrames;
  else if (video.nb_frames && Number(video.nb_frames) > 0) frameCount = Number(video.nb_frames);
  else if (durationSec > 0) frameCount = Math.round((durationSec * fps.num) / fps.den);

  const transfer = String(video.color_transfer ?? '');
  const primaries = String(video.color_primaries ?? '');
  const hdr = HDR_TRANSFERS.has(transfer) || HDR_PRIMARIES.has(primaries);

  // 起始时间码：流上的 timecode tag 或 start_time 换算
  let startTimecode: string | null = video.tags?.timecode ?? null;

  return {
    hasVideo: true,
    hasAudio: audioStreams > 0,
    fps,
    sourceAvgFps: avg,
    sourceRealFps: real,
    vfr,
    interlaced,
    hdr,
    rotation,
    width,
    height,
    displayWidth: swap ? height : width,
    displayHeight: swap ? width : height,
    frameCount,
    durationSec,
    startTimecode,
    audioStreams,
    probe,
  };
}

export interface TranscodePlan {
  fps: Fps;
  /** 视频滤镜链 */
  filters: string[];
  videoArgs: string[];
  audioArgs: string[];
  forceCfr: boolean;
  outputPixFmt: string;
}

/** 可配置的转码参数（后台"系统设置-转码"） */
export interface TranscodeOptions {
  crf?: number;
  maxRateMbps?: number;
  preset?: string;
  /** 长边上限（0 = 默认 1920/1080 逻辑） */
  maxLongSidePx?: number;
}

/** 根据媒体信息构建 ffmpeg 代理转码参数（纯函数） */
export function buildProxyPlan(info: MediaInfo, opts: TranscodeOptions = {}): TranscodePlan {
  const fps = info.fps ?? { num: 25, den: 1 };
  const crf = opts.crf ?? 20;
  const maxRate = opts.maxRateMbps ?? 12;
  const preset = opts.preset ?? 'medium';
  const longSide = opts.maxLongSidePx && opts.maxLongSidePx > 0 ? opts.maxLongSidePx : 1920;
  const shortSide = Math.round(longSide / 16 * 9); // 16:9 假设下的短边上限（clamp 到 1080 风格）
  const filters: string[] = [];

  if (info.interlaced) filters.push('bwdif=mode=send_frame:parity=auto:deint=all');

  if (info.hdr) {
    // HDR(HLG/PQ) -> SDR BT.709，否则画面发灰
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709:t=bt709:m=bt709:r=tv',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:r=tv',
    );
  }

  // 低于上限的源保持原分辨率，只做偶数对齐；ffmpeg 已自动旋转（autorotate）
  filters.push(
    `scale=w='min(iw,${longSide})':h='min(ih,${shortSide})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  );
  filters.push('format=yuv420p');

  const gop = Math.max(1, Math.round(fps.num / fps.den)); // GOP ≈ 1 秒
  const videoArgs = [
    '-c:v', 'libx264',
    '-preset', preset,
    '-profile:v', 'high',
    '-crf', String(crf),
    '-maxrate', `${maxRate}M`, '-bufsize', `${maxRate * 2}M`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ];

  // 可变帧率（手机录屏等）按平均帧率归到最近标准帧率强制 CFR；
  // CFR 源也统一带上 -r（吸附值与源一致时帧数不变），保证代理帧时基确定
  const forceCfr = true;
  videoArgs.push('-fps_mode', 'cfr', '-r', `${fps.num}/${fps.den}`);

  const audioArgs = info.hasAudio
    ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
    : ['-an'];

  return { fps, filters, videoArgs, audioArgs, forceCfr, outputPixFmt: 'yuv420p' };
}

/** 海碧图参数：目标 <= 120 张缩略图 */
export function spritePlan(info: MediaInfo, thumbW = 160) {
  const duration = info.durationSec || 1;
  const intervalSec = Math.max(1, Math.ceil(duration / 120));
  const count = Math.max(1, Math.ceil(duration / intervalSec));
  const cols = Math.min(10, count);
  const rows = Math.ceil(count / cols);
  return { intervalSec, count, cols, rows, thumbW };
}

/** 海碧图 / 封面共用：HDR 源截图同样需要 tonemap，否则缩略图发灰 */
export function stillFilters(info: MediaInfo, scaleExpr: string): string[] {
  const f: string[] = [];
  if (info.interlaced) f.push('bwdif=mode=send_frame:parity=auto:deint=all');
  if (info.hdr) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709:t=bt709:m=bt709:r=tv',
      'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:r=tv');
  }
  f.push(scaleExpr, 'format=yuv420p');
  return f;
}
