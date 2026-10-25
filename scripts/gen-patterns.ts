/**
 * 生成帧精度测试片（文档 8.M0）：16 条竖纹按二进制编码帧号。
 * 用法：npx tsx scripts/gen-patterns.ts [输出目录=test-assets/patterns]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'test-assets/patterns';
fs.mkdirSync(outDir, { recursive: true });

const RATES = ['24000/1001', '25/1', '30000/1001', '30/1', '50/1', '60000/1001', '60/1'];

for (const rate of RATES) {
  const tag = rate.replace('/', '_');
  const out = path.join(outDir, `test_${tag}.mov`);
  if (fs.existsSync(out)) {
    console.log(`跳过已存在: ${out}`);
    continue;
  }
  console.log(`生成 ${out} (r=${rate})...`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=gray:s=320x180:r=${rate}:d=60`,
    '-vf', "geq=lum='if(mod(floor(N/pow(2,floor(X*16/W))),2),235,16)':cb=128:cr=128,scale=1920:1080:flags=neighbor",
    '-c:v', 'prores_ks', '-profile:v', '2',
    out,
  ], { stdio: 'inherit' });
}

console.log('\n完成。导入示例：');
console.log('  pnpm --filter @frametalk/server seed-demo test-assets/patterns/test_30000_1001.mov 帧精度');
