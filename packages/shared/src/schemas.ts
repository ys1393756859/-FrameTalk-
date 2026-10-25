import { z } from 'zod';
import { PROJECT_ROLES, REVIEW_STATUSES, COMMENT_LABELS } from './roles.js';

export { z };

/** 内网账号允许无点号域名（admin@local 等）；手机号登录也走这个字段 */
const emailField = z.string().regex(/^[^\s@]+@[^\s@]+$/, '邮箱格式不正确');
const phoneField = z.string().regex(/^1\d{10}$/, '手机号格式不正确（11 位）');

/* ---------- 认证 ---------- */
export const loginSchema = z.object({
  account: emailField.or(phoneField),
  password: z.string().min(1),
});
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8, '至少 8 位'),
});

/* ---------- 用户管理 ---------- */
export const USER_TITLES = ['导演', '制片', '剪辑', '生成'] as const;
export type UserTitle = (typeof USER_TITLES)[number];

export const createUserSchema = z.object({
  name: z.string().min(1).max(50),
  email: emailField.optional(),
  phone: phoneField.optional(),
  password: z.string().min(8, '至少 8 位'),
  isAdmin: z.boolean().default(false),
  title: z.string().max(30).optional(),
}).refine((v) => v.email || v.phone, { message: '邮箱和手机号至少填一个', path: ['email'] });
export const updateUserSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  email: emailField.nullable().optional(),
  phone: phoneField.nullable().optional(),
  isAdmin: z.boolean().optional(),
  title: z.string().max(30).nullable().optional(),
  disabled: z.boolean().optional(), // true = 禁用，false = 启用
  newPassword: z.string().min(8).optional(), // 管理员重置，重置后强制改密
});

/* ---------- 项目 ---------- */
export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(['self', 'external']).optional(),
  description: z.string().max(500).optional(),
});
export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(PROJECT_ROLES),
});
export const updateMemberSchema = z.object({
  role: z.enum(PROJECT_ROLES),
});

/* ---------- 文件夹 / 资产 ---------- */
export const createFolderSchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.string().uuid().nullable().optional(),
});
export const renameSchema = z.object({ name: z.string().min(1).max(200) });
export const moveAssetSchema = z.object({
  folderId: z.string().uuid().nullable(),
});
export const reviewStatusSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
});

/* ---------- 批注 ---------- */
export const drawingShapeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('pen'),
    pts: z.array(z.number()), // 归一化点列 [x0,y0,x1,y1,...]
    color: z.string(),
    w: z.number(), // 线宽（相对视频高度）
  }),
  z.object({
    t: z.literal('arrow'),
    pts: z.array(z.number()).length(4),
    color: z.string(),
    w: z.number(),
  }),
  z.object({
    t: z.literal('rect'),
    pts: z.array(z.number()).length(4), // x1,y1,x2,y2
    color: z.string(),
    w: z.number(),
  }),
  z.object({
    t: z.literal('text'),
    x: z.number(),
    y: z.number(),
    text: z.string().max(500),
    color: z.string(),
    size: z.number(), // 相对视频高度
  }),
]);
export const drawingSchema = z.object({ shapes: z.array(drawingShapeSchema) });
export type Drawing = z.infer<typeof drawingSchema>;
export type DrawingShape = z.infer<typeof drawingShapeSchema>;

export const createCommentSchema = z.object({
  frameIn: z.number().int().min(0).optional(), // 楼主必填；回复（带 parentId）继承父评论帧号，可省略
  frameOut: z.number().int().min(0).nullable().optional(), // >= frameIn，存在则为区间批注
  body: z.string().max(5000).optional(),
  drawing: drawingSchema.nullable().optional(),
  labels: z.array(z.string().min(1).max(20)).max(5).optional(), // 内置标签 + 项目自定义标签
  mentions: z.array(z.string().uuid()).max(20).optional(),
  parentId: z.string().uuid().nullable().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(), // 已上传的附件 id
}).refine((v) => v.frameIn != null || v.parentId != null, {
  message: '必须提供 frameIn（回复可省略，自动继承父评论帧号）',
});
export const updateCommentSchema = z.object({
  body: z.string().max(5000).optional(),
  resolved: z.boolean().optional(),
});
export type CommentLabelValue = z.infer<typeof createCommentSchema>['labels'];

/* ---------- 关联帧 ---------- */
export const createFrameLinkSchema = z.object({
  baseVersionId: z.string().uuid(),
  baseFrame: z.number().int().min(0),
  versionId: z.string().uuid(),
  frame: z.number().int().min(0),
  note: z.string().max(200).nullish(),
});
