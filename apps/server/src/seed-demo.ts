/**
 * 演示/测试数据初始化：确保管理员与演示项目存在，导入本地视频文件为一个资产（同步转码）。
 * 用法：tsx src/seed-demo.ts <视频文件路径> [项目名]
 */
import path from 'node:path';
import { prisma } from './db.js';
import { env, mediaDir } from './env.js';
import { hashPassword } from './auth/password.js';
import { ensureDir, sanitizeFilename, statSafe } from './util.js';
import { transcodeVersion } from './media/run.js';
import fsp from 'node:fs/promises';
import { timecodeToFrames, type Fps } from '@frametalk/shared';

async function main() {
  const file = process.argv[2];
  const projectName = process.argv[3] || '演示项目';

  const admin = await prisma.user.upsert({
    where: { email: env.INITIAL_ADMIN_EMAIL },
    update: {},
    create: {
      name: env.INITIAL_ADMIN_NAME, email: env.INITIAL_ADMIN_EMAIL,
      passwordHash: await hashPassword(env.INITIAL_ADMIN_PASSWORD),
      isAdmin: true, mustChangePassword: false,
    },
  });
  const project = await prisma.project.upsert({
    where: { name: projectName },
    update: {},
    create: { name: projectName, members: { create: { userId: admin.id, role: 'manager' } } },
  });
  console.log(`项目就绪: ${project.id}`);

  if (!file) {
    console.log('未提供视频文件，跳过导入');
    return;
  }
  const abs = path.resolve(file);
  if (!(await statSafe(abs))) throw new Error(`文件不存在: ${abs}`);

  const versionId = crypto.randomUUID();
  const safe = sanitizeFilename(path.basename(abs));
  const destDir = path.join(mediaDir(), 'originals', versionId);
  await ensureDir(destDir);
  await fsp.copyFile(abs, path.join(destDir, safe));
  const st = await statSafe(abs)!;

  const asset = await prisma.asset.create({
    data: { projectId: project.id, name: safe.replace(/\.[^.]+$/, ''), kind: 'video' },
  });
  const version = await prisma.assetVersion.create({
    data: {
      id: versionId, assetId: asset.id, versionNo: 1,
      originalName: safe, filePath: `originals/${versionId}/${safe}`,
      size: BigInt(st!.size), mime: 'video/mp4', status: 'transcoding', uploadedBy: admin.id,
    },
  });
  console.log(`开始同步转码 ${safe} (${(st!.size / 1024 / 1024).toFixed(1)} MB)...`);
  const artifacts = await transcodeVersion(versionId, path.join(destDir, safe), (pct, stage) => {
    if (pct % 10 < 2) process.stdout.write(`  ${pct}% ${stage}\n`);
  });
  let startFrames = 0;
  if (artifacts.info.startTimecode && artifacts.info.fps) {
    try { startFrames = timecodeToFrames(artifacts.info.startTimecode, artifacts.info.fps as Fps); } catch { /* ignore */ }
  }
  await prisma.assetVersion.update({
    where: { id: versionId },
    data: {
      status: artifacts.proxyRel ? 'ready' : 'unsupported', progress: 100,
      fpsNum: artifacts.info.fps?.num ?? null, fpsDen: artifacts.info.fps?.den ?? null,
      frameCount: artifacts.proxyFrames ?? artifacts.info.frameCount ?? null,
      durationSec: artifacts.info.durationSec,
      startTimecode: artifacts.info.startTimecode, startFrames,
      width: artifacts.info.displayWidth, height: artifacts.info.displayHeight,
      probe: artifacts.info.probe as any,
    },
  });
  console.log(`完成: asset=${asset.id} version=${version.id}`);
  console.log(`帧率 ${artifacts.info.fps?.num}/${artifacts.info.fps?.den}  帧数 ${artifacts.proxyFrames}  时长 ${artifacts.info.durationSec.toFixed(2)}s`);
  console.log(`\n审阅页地址: /p/${project.id}/a/${asset.id}?v=${version.id}`);
}

main().catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
