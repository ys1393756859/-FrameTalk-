/** 项目四级角色：管理者 > 编辑 > 审阅 > 只读 */
export const PROJECT_ROLES = ['manager', 'editor', 'reviewer', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ROLE_LEVEL: Record<ProjectRole, number> = {
  manager: 3,
  editor: 2,
  reviewer: 1,
  viewer: 0,
};

export const ROLE_LABEL: Record<ProjectRole, string> = {
  manager: '管理者',
  editor: '编辑',
  reviewer: '审阅',
  viewer: '只读',
};

export function roleAtLeast(actual: ProjectRole | 'admin', required: ProjectRole): boolean {
  if (actual === 'admin') return true; // 系统管理员视同管理者
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

export const REVIEW_STATUSES = ['pending', 'in_review', 'needs_change', 'approved'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: '待审',
  in_review: '审阅中',
  needs_change: '需修改',
  approved: '已通过',
};

export type AssetKind = 'video' | 'audio' | 'image' | 'other';

export type VersionStatus =
  | 'uploading'
  | 'queued'
  | 'transcoding'
  | 'ready'
  | 'failed'
  | 'unsupported';

export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = {
  uploading: '上传中',
  queued: '排队转码',
  transcoding: '转码中',
  ready: '可播放',
  failed: '转码失败',
  unsupported: '不支持预览',
};

export const COMMENT_LABELS = ['urgent', 'suggestion', 'reference'] as const;
export type CommentLabel = (typeof COMMENT_LABELS)[number];
export const COMMENT_LABEL_TEXT: Record<CommentLabel, string> = {
  urgent: '紧急',
  suggestion: '建议',
  reference: '参考',
};
/** 内置标签颜色 */
export const BUILTIN_LABEL_COLORS: Record<CommentLabel, string> = {
  urgent: '#ff4d4f',
  suggestion: '#faad14',
  reference: '#4f7cff',
};
/** 新建自定义标签可选色板 */
export const LABEL_PALETTE = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#4f7cff', '#b37feb', '#8c8c8c'] as const;
/** 项目自定义标签 */
export interface CustomLabel { name: string; color: string }
