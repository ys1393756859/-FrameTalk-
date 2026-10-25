/**
 * 系统设置页 5 个 Tab 布局目检截图（一次性验证脚本）。
 * 运行：node e2e/settings-shots.mjs（:3000 需在跑，构建产物为最新）
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3000';
const OUT = 'gui-test-screenshots'; // 相对仓库根目录运行

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.locator('input[placeholder="邮箱或手机号"]').fill('admin@local');
await page.locator('input[type="password"]').first().fill('changeme123');
await page.getByRole('button', { name: /登\s*录/ }).click();
await page.waitForTimeout(1500);

await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
await page.locator('.ant-tabs-nav').waitFor({ timeout: 10000 });

const tabs = [
  ['存储', 'storage'],
  ['站点', 'general'],
  ['安全', 'security'],
  ['转码', 'transcode'],
  ['飞书通知', 'feishu'],
];
for (const [name, key] of tabs) {
  await page.getByRole('tab', { name }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/settings-${key}.png`, fullPage: true });
  console.log('shot', key);
}

// 存储 tab 切到 WebDAV，看条件字段的双列布局（不点保存，不落库）
await page.getByRole('tab', { name: '存储' }).click();
await page.waitForTimeout(300);
await page.locator('.ant-select').first().click();
await page.waitForTimeout(300);
await page.locator('.ant-select-item-option[title="WebDAV"]').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/settings-storage-webdav.png`, fullPage: true });
console.log('shot storage-webdav');

await browser.close();
console.log('done');
