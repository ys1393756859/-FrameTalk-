import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 递归创建目录 */
export async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

export async function statSafe(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** 文件名消毒：去掉路径分隔符与控制字符，保留中文与常见字符 */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return base.length ? base.slice(0, 180) : 'unnamed';
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 磁盘剩余空间（字节）；statfs 在 node >= 18.15 可用 */
export async function diskFree(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    await fsp.access(dir);
  } catch {
    try {
      await ensureDir(dir);
    } catch {
      return null;
    }
  }
  try {
    const st = fs.statfsSync(dir);
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return null;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 执行命令并收集输出（stdout/stderr 截断保留尾部，用于错误展示） */
export function run(cmd: string, args: string[], opts: { onStdout?: (chunk: string) => void; maxBuffer?: number } = {}): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      if (opts.onStdout) opts.onStdout(s);
      stdout += s;
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function ffprobeJson(file: string): Promise<any> {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe 失败: ${stderr.slice(-2000)}`);
  return JSON.parse(stdout);
}

export function stderrTail(stderr: string, lines = 15): string {
  return stderr.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/** BigInt 安全 JSON 化（Prisma size 字段） */
export function toJson(v: unknown): any {
  return JSON.parse(JSON.stringify(v, (_, val) => (typeof val === 'bigint' ? Number(val) : val)));
}
