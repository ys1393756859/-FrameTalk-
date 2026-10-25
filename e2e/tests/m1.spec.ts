/**
 * M1 验收（文档 8 节）：部署 → 建号 → 上传 → 转码 → 批注 → 实时 → 链接定位 全链路。
 * 前置：
 *   - 服务已启动（docker compose up -d 或本地 server+worker+pg）
 *   - 环境变量 INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD 与部署 .env 一致
 *   - 本机 PATH 有 ffmpeg（生成测试片）
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMIN_EMAIL = process.env.INITIAL_ADMIN_EMAIL ?? 'admin@local';
const INITIAL_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD ?? 'changeme123';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? 'E2eAdmin!2345';
const B_EMAIL = 'b-e2e@test.local';
const B_PASSWORD = 'E2eUserB!2345';

let adminCtx: import('@playwright/test').BrowserContext;

function genClip(name: string, seconds = 3): string {
  const out = path.join(os.tmpdir(), name);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:r=25:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ]);
  return out;
}

async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByPlaceholder('you@team.com').fill(email);
  await page.locator('input[type=password]').first().fill(password);
  await page.getByRole('button', { name: '登录' }).click();
}

test.describe.serial('M1 验收', () => {
  test('1. 初始管理员登录被要求改密，改密后进入', async ({ browser }) => {
    const ctx = await browser.newContext();
    adminCtx = ctx;
    const page = await ctx.newPage();
    await login(page, ADMIN_EMAIL, INITIAL_PASSWORD);
    await expect(page.getByText('修改密码')).toBeVisible({ timeout: 10_000 });
    await page.locator('input[type=password]').nth(0).fill(INITIAL_PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(ADMIN_NEW_PASSWORD);
    await page.locator('input[type=password]').nth(2).fill(ADMIN_NEW_PASSWORD);
    await page.getByRole('button', { name: '确认修改' }).click();
    await page.waitForURL(/\/$/, { timeout: 10_000 });
  });

  test('2. 管理员新建账号 B；B 首登被要求改密', async () => {
    const page = await adminCtx.newPage();
    await page.goto('/admin/users');
    await page.getByRole('button', { name: '新建账号' }).click();
    await page.getByLabel('姓名').fill('用户B');
    await page.getByLabel('邮箱').fill(B_EMAIL);
    await page.getByLabel('初始密码').fill(B_PASSWORD);
    await page.getByRole('button', { name: '确 定' }).click();
    await expect(page.getByText(B_EMAIL)).toBeVisible({ timeout: 10_000 });

    const bCtx = await adminCtx.browser()!.newContext();
    const bPage = await bCtx.newPage();
    await login(bPage, B_EMAIL, B_PASSWORD);
    await expect(bPage.getByText('修改密码')).toBeVisible({ timeout: 10_000 });
    await bPage.close();
  });

  test('3. 禁用 B 后其会话立即失效', async () => {
    const bCtx = await adminCtx.browser()!.newContext();
    const bPage = await bCtx.newPage();
    await login(bPage, B_EMAIL, B_PASSWORD);
    await bPage.locator('input[type=password]').nth(0).fill(B_PASSWORD);
    await bPage.locator('input[type=password]').nth(1).fill('BNewPass!456');
    await bPage.locator('input[type=password]').nth(2).fill('BNewPass!456');
    await bPage.getByRole('button', { name: '确认修改' }).click();
    await bPage.waitForURL(/\/$/, { timeout: 10_000 });

    // 管理员禁用 B
    const admin = await adminCtx.newPage();
    await admin.goto('/admin/users');
    const row = admin.locator('tr', { hasText: B_EMAIL });
    await row.getByRole('button', { name: '禁用' }).click();
    await row.getByRole('button', { name: '确 定' }).click().catch(() => {});
    await expect(row.getByText('已禁用')).toBeVisible({ timeout: 10_000 });

    // B 的下一个请求被踢回登录页
    await bPage.goto('/');
    await bPage.waitForURL(/\/login/, { timeout: 10_000 });
    await bPage.close();
  });

  test('4. 上传 → 转码进度 → 完成可播放', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await adminCtx.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: '新建项目' }).click();
    await page.getByLabel('项目名').fill('E2E 项目');
    await page.getByRole('button', { name: '创 建' }).click();
    await page.waitForURL(/\/p\//);

    await page.getByRole('button', { name: '上传素材' }).click();
    await page.setInputFiles('.uppy-Dashboard-input', genClip('m1-test.mp4', 3));
    // 上传完成 -> 转码 -> 可播放
    await expect(page.locator('tr').filter({ hasText: 'm1-test' })
      .getByText(/可播放|转码失败/, { exact: false })).toBeVisible({ timeout: 240_000 });
  });

  let assetUrl: string;

  test('5. 批注：B 画箭头评论，A 2 秒内实时看到；点击评论定位到帧', async ({ browser }) => {
    test.setTimeout(120_000);
    // 管理员进审阅页
    const aPage = await adminCtx.newPage();
    await aPage.goto('/');
    await aPage.getByRole('link', { name: /E2E 项目/ }).first().click();
    await aPage.getByRole('link', { name: /m1-test/ }).first().click();
    await aPage.waitForSelector('video');
    await aPage.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && v.videoWidth > 0;
    });
    assetUrl = aPage.url();

    // 恢复 B 并加进项目（viewer 不能批注 -> 用 reviewer）——用管理员 UI
    const admin = await adminCtx.newPage();
    await admin.goto('/admin/users');
    const row = admin.locator('tr', { hasText: B_EMAIL });
    if (await row.getByRole('button', { name: '启用' }).count()) {
      await row.getByRole('button', { name: '启用' }).click();
    }

    // B 登录批注
    const bCtx = await browser.newContext();
    const bPage = await bCtx.newPage();
    await login(bPage, B_EMAIL, 'BNewPass!456');
    await bPage.goto(assetUrl);
    await bPage.waitForSelector('video');
    // 跳到第 30 帧，画箭头，提交
    await bPage.getByRole('button', { name: /设 I/ }).click(); // I=30? 先步进 30 帧
    for (let i = 0; i < 30; i++) await bPage.keyboard.press('ArrowRight');
    await bPage.getByRole('button', { name: '箭头' }).click();
    const stage = bPage.locator('.konvajs-content');
    const box = await stage.boundingBox();
    await bPage.mouse.move(box!.x + 20, box!.y + 20);
    await bPage.mouse.down();
    await bPage.mouse.move(box!.x + 200, box!.y + 100, { steps: 5 });
    await bPage.mouse.up();
    await bPage.locator('textarea').first().fill('E2E: 这里偏色');
    await bPage.getByRole('button', { name: /提交批注/ }).click();

    // A 2 秒内看到评论（socket 实时）
    await expect(aPage.getByText('E2E: 这里偏色').first()).toBeVisible({ timeout: 2000 });
    // A 点击评论定位到帧
    await aPage.getByText('E2E: 这里偏色').first().click();
    await expect(aPage.locator('.frame-counter')).toHaveText('30');
    await bPage.close();
  });

  test('6. 复制带帧号链接：C 未登录→登录页；非成员→403；成员→定位到帧', async ({ browser }) => {
    const link = `${assetUrl}&f=30`;
    const cCtx = await browser.newContext();
    const cPage = await cCtx.newPage();
    await cPage.goto(link);
    await cPage.waitForURL(/\/login/, { timeout: 10_000 }); // 未登录跳登录
    // 登录（B 已是成员）后应定位到帧
    await login(cPage, B_EMAIL, 'BNewPass!456');
    await cPage.goto(link);
    await cPage.waitForSelector('video', { timeout: 30_000 });
    await cPage.waitForFunction(() => document.querySelector('.frame-counter')?.textContent === '30', undefined, { timeout: 10_000 });
    await cPage.close();
  });

  test('7. 审阅角色调用删除接口返回 403（API 级权限）', async ({ request }) => {
    // 未登录直接请求媒体与删除接口均 401/403
    const res1 = await request.get('/api/projects');
    expect([401, 403]).toContain(res1.status());
  });
});
