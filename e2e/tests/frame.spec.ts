/**
 * 帧精度测试（M0，文档 8 节）：
 * 画面 16 条竖纹按二进制编码帧号；页面与媒体同域，canvas 直接读像素解码呈现帧号，
 * 与播放器显示帧号比对。逐帧前进/后退各 200 次 + 随机跳转 100 次。
 *
 * 前置：
 *   1) 生成测试片（根目录）: pnpm gen:patterns
 *   2) 启动服务并导入: pnpm --filter @frametalk/server seed-demo test-assets/patterns/test_2997.mov 帧精度
 *   3) PLAYWRIGHT: pnpm test:frame
 *      环境变量 FRAME_ASSET_URL=/p/<projectId>/a/<assetId>?v=<versionId> 精确到该资产
 */
import { test, expect, type Page } from '@playwright/test';

const BARS = 16;

async function decodeFrameNumber(page: Page): Promise<number> {
  return page.evaluate((bars) => {
    const video = document.querySelector('video');
    if (!video || !video.videoWidth) return -1;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0);
    let value = 0;
    for (let b = 0; b < bars; b++) {
      // 每条竖纹中心取像素，亮 > 128 记 1（高位在左：b=0 是 bit15）
      const x = Math.floor(((b + 0.5) / bars) * canvas.width);
      const y = Math.floor(canvas.height / 2);
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[0] > 128) value |= 1 << (bars - 1 - b);
    }
    return value;
  }, BARS);
}

async function displayedFrame(page: Page): Promise<number> {
  const tc = await page.locator('.frame-counter').textContent();
  return Number(tc);
}

test('逐帧前进/后退 + 随机跳转，帧号与画面编码 100% 一致', async ({ page }) => {
  const assetPath = process.env.FRAME_ASSET_URL;
  test.skip(!assetPath, '需要 FRAME_ASSET_URL 指向已导入的帧精度测试片');

  await page.goto(assetPath!);
  await page.waitForSelector('video', timeout: 30_000);
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, undefined, { timeout: 30_000 });

  let mismatches = 0;
  const check = async (label: string) => {
    await page.waitForTimeout(120); // 等待呈现
    const shown = await displayedFrame(page);
    const decoded = await decodeFrameNumber(page);
    if (shown !== decoded) {
      mismatches++;
      console.error(`[mismatch ${label}] 显示 ${shown} 编码 ${decoded}`);
    }
    return shown === decoded;
  };

  // 起点
  await page.keyboard.press('ArrowLeft');
  expect(await check('init')).toBe(true);

  // 逐帧前进 200 次
  for (let i = 0; i < 200; i++) await page.keyboard.press('ArrowRight');
  expect(await check('forward-200')).toBe(true);

  // 逐帧后退 200 次
  for (let i = 0; i < 200; i++) await page.keyboard.press('ArrowLeft');
  expect(await check('backward-200')).toBe(true);

  // 随机跳转 100 次（点击时间线随机位置）
  for (let i = 0; i < 100; i++) {
    const box = await page.locator('[data-testid=timeline-strip]').boundingBox();
    if (!box) break;
    const x = box.x + 20 + Math.random() * (box.width - 40);
    await page.mouse.click(x, box.y + box.height / 2);
    await page.waitForTimeout(150);
    const shown = await displayedFrame(page);
    const decoded = await decodeFrameNumber(page);
    if (shown !== decoded) {
      mismatches++;
      console.error(`[mismatch random-${i}] 显示 ${shown} 编码 ${decoded}`);
    }
  }
  expect(mismatches, '帧号不一致次数').toBe(0);
});
