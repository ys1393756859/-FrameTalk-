import { defineConfig } from '@playwright/test';

// 浏览器须用系统 Chrome/Edge（内置 Chromium 无 H.264 解码）
export default defineConfig({
  testDir: './tests',
  timeout: 300_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.APP_URL ?? 'http://127.0.0.1:3000',
    channel: process.env.BROWSER_CHANNEL ?? 'chrome',
    video: 'off',
    trace: 'retain-on-failure',
  },
});
