import { z } from 'zod';

/**
 * 系统设置分组（后台"系统设置"页配置，存 SettingGroup 表，即时生效）。
 * 扩展方式：在这里加一个分组 schema + 默认值，后台设置页会自动多一个 Tab。
 */

export const storageSettingsSchema = z.object({
  backend: z.enum(['local', 'webdav', 'ftp']).default('local'),
  webdavBaseUrl: z.string().default(''),
  webdavUsername: z.string().default(''),
  /** 保存时留空 = 保持原值不改；回读永远是 *** */
  webdavPassword: z.string().default(''),
  ftpHost: z.string().default(''),
  ftpPort: z.coerce.number().int().min(1).max(65535).default(21),
  ftpUser: z.string().default(''),
  ftpPassword: z.string().default(''),
  ftpSecure: z.boolean().default(false),
});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export const DEFAULT_STORAGE: StorageSettings = storageSettingsSchema.parse({});

export const generalSettingsSchema = z.object({
  siteName: z.string().min(1).max(50).default('审片协作平台'),
  /** 单文件上传上限（GB），0 = 不限 */
  maxUploadGb: z.coerce.number().min(0).max(2048).default(200),
  /** tmp 目录未完成上传的保留小时数 */
  tmpRetentionHours: z.coerce.number().int().min(1).max(720).default(24),
  /** 回收站保留天数 */
  trashRetentionDays: z.coerce.number().int().min(1).max(365).default(30),
  /** 磁盘剩余告警阈值（%） */
  diskWarnPercent: z.coerce.number().int().min(1).max(99).default(15),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export const DEFAULT_GENERAL: GeneralSettings = generalSettingsSchema.parse({});

export const securitySettingsSchema = z.object({
  /** 会话有效期（天） */
  sessionDays: z.coerce.number().int().min(1).max(90).default(7),
  /** 登录失败锁定：次数 */
  loginFailLimit: z.coerce.number().int().min(1).max(100).default(5),
  /** 登录失败锁定：分钟数 */
  loginLockMinutes: z.coerce.number().int().min(1).max(1440).default(10),
  /** 密码最小长度 */
  passwordMinLength: z.coerce.number().int().min(8).max(64).default(8),
  /** 允许自注册（登录页显示注册入口；关闭时注册接口返回 403） */
  allowSelfRegister: z.boolean().default(false),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export const DEFAULT_SECURITY: SecuritySettings = securitySettingsSchema.parse({});

export const transcodeSettingsSchema = z.object({
  /** x264 质量（CRF，越小画质越高） */
  crf: z.coerce.number().int().min(14).max(28).default(20),
  /** 代理码率上限 Mbps */
  maxRateMbps: z.coerce.number().int().min(2).max(60).default(12),
  /** x264 预设：ultrafast..veryslow */
  preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow']).default('medium'),
  /** 代理分辨率上限（长边不超过；0=不限，仍受 1920/1080 逻辑约束） */
  maxLongSidePx: z.coerce.number().int().min(0).max(3840).default(0),
  /** 转码失败自动重试次数 */
  retryLimit: z.coerce.number().int().min(0).max(10).default(2),
});
export type TranscodeSettings = z.infer<typeof transcodeSettingsSchema>;
export const DEFAULT_TRANSCODE: TranscodeSettings = transcodeSettingsSchema.parse({});

export const feishuSettingsSchema = z.object({
  /** 总开关：关闭后不再产生新的群通知（缓冲中未发送的摘要超过 24h 自动作废） */
  enabled: z.boolean().default(false),
  /** 飞书自建应用 App ID（cli_…）：开放平台 → 应用 → 凭证与基础信息 */
  appId: z.string().default(''),
  /** 飞书自建应用 App Secret（秘密字段，回读打码） */
  appSecret: z.string().default(''),
  /** 目标飞书群 chat_id（oc_…，机器人须已拉进群；可在后台「获取群列表」拉取） */
  chatId: z.string().default(''),
  /** 聚合窗口（分钟）：窗口内同一项目的评论合并成一条 @ 摘要，避免每条评论都 @ */
  windowMinutes: z.coerce.number().int().min(1).max(180).default(10),
  /** 每项目每天最多发多少条 @ 消息，0 = 不限；超出的摘要丢弃并记日志 */
  dailyMax: z.coerce.number().int().min(0).max(200).default(20),
  /** 免打扰开始 HH:mm（与结束都填才生效，支持跨午夜），期间缓冲不发送，结束后合并成一条 */
  quietStart: z.string().default(''),
  /** 免打扰结束 HH:mm */
  quietEnd: z.string().default(''),
  /** 评论里显式 @提及 了人时视为紧急，绕过聚合窗口立即发送（仍受 30s 最小发送间隔约束） */
  mentionBypass: z.boolean().default(true),
  /** @ 名单是否包含评论作者本人（默认不含：自己发的评论不 @ 自己） */
  atAuthor: z.boolean().default(false),
  /** 审片平台访问地址（如 http://192.168.1.10:3000）：卡片「去查看与回复」按钮的深链前缀，留空不显示按钮 */
  platformUrl: z.string().max(200).default(''),
});
export type FeishuSettings = z.infer<typeof feishuSettingsSchema>;
export const DEFAULT_FEISHU: FeishuSettings = feishuSettingsSchema.parse({});

export const SETTING_GROUPS = {
  storage: { schema: storageSettingsSchema, defaults: DEFAULT_STORAGE, label: '存储', secretKeys: ['webdavPassword', 'ftpPassword'] },
  general: { schema: generalSettingsSchema, defaults: DEFAULT_GENERAL, label: '站点', secretKeys: [] },
  security: { schema: securitySettingsSchema, defaults: DEFAULT_SECURITY, label: '安全', secretKeys: [] },
  transcode: { schema: transcodeSettingsSchema, defaults: DEFAULT_TRANSCODE, label: '转码', secretKeys: [] },
  feishu: { schema: feishuSettingsSchema, defaults: DEFAULT_FEISHU, label: '飞书通知', secretKeys: ['appSecret'] },
} as const;
export type SettingGroupKey = keyof typeof SETTING_GROUPS;

/** 密码占位符：保存时提交该值表示"不修改" */
export const SECRET_KEEP = '__KEEP__';
