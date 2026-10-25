import type { ProjectRole, ReviewStatus, AssetKind, VersionStatus } from './roles.js';

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export type ProjectKind = 'self' | 'external';

export interface ProjectSummary {
  id: string;
  name: string;
  kind: ProjectKind;
  description?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  myRole: ProjectRole | 'admin';
  memberCount: number;
}

export interface FolderDto {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
}

export interface VersionDto {
  id: string;
  assetId: string;
  versionNo: number;
  originalName: string;
  size: number;
  mime: string;
  status: VersionStatus;
  progress: number;
  error?: string | null;
  fpsNum?: number | null;
  fpsDen?: number | null;
  frameCount?: number | null;
  durationSec?: number | null;
  startTimecode?: string | null;
  startFrames?: number;
  width?: number | null;
  height?: number | null;
  uploadedByName?: string | null;
  createdAt: string;
  updatedAt?: string;
  probe?: any; // ffprobe 原始输出（信息面板：视频/音频流详情）
  hasProxy: boolean;
  hasPoster: boolean;
  sprite?: { intervalSec: number; cols: number; rows: number; thumbW: number; thumbH: number; count: number } | null;
}

export interface AssetDto {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  description?: string | null; // 文件描述（信息面板可编辑）
  kind: AssetKind;
  reviewStatus: ReviewStatus;
  deletedAt: string | null;
  latestVersion?: VersionDto | null;
  versionCount: number;
  createdAt?: string;
  updatedAt: string;
}

export interface CommentAttachmentDto {
  id: string;
  filename: string;
  mime: string;
  size: string; // BigInt 序列化为字符串
}

export interface CommentDto {
  id: string;
  versionId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  authorTitle?: string | null;
  frameIn: number;
  frameOut: number | null;
  body?: string | null;
  drawing?: unknown;
  labels?: string[] | null;
  mentions?: string[] | null; // 被 @ 的用户 id 列表
  attachments?: CommentAttachmentDto[];
  resolvedAt: string | null;
  resolvedByName?: string | null;
  createdAt: string;
}

export interface FrameLinkDto {
  id: string;
  assetId: string;
  baseVersionId: string; // 主版本（最新版）
  baseFrame: number;
  versionId: string; // 被关联的对比版本
  frame: number;
  note?: string | null;
  createdBy: string;
  creatorName: string;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
