import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MEDIA_DIR: z.string().default('./data/media'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // 原片归档存储：local（默认）| webdav | ftp；代理等转码产物始终本地
  STORAGE_BACKEND: z.enum(['local', 'webdav', 'ftp']).default('local'),
  WEBDAV_BASE_URL: z.string().default(''),
  WEBDAV_USERNAME: z.string().default(''),
  WEBDAV_PASSWORD: z.string().default(''),
  FTP_HOST: z.string().default(''),
  FTP_PORT: z.coerce.number().default(21),
  FTP_USER: z.string().default(''),
  FTP_PASSWORD: z.string().default(''),
  FTP_SECURE: z.string().default('0'),
  // 允许内网式域名（admin@local 等无点号 TLD）
  INITIAL_ADMIN_EMAIL: z.string().regex(/^[^\s@]+@[^\s@]+$/, '邮箱格式不正确').default('admin@local'),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).default('changeme123'),
  INITIAL_ADMIN_NAME: z.string().default('管理员'),
  MIGRATE_ON_BOOT: z.string().default('1'),
  WORKER_ID: z.string().default('worker-1'),
  LOG_LEVEL: z.string().default('info'),
});

export const env = schema.parse(process.env);

export const mediaDir = () => env.MEDIA_DIR;
