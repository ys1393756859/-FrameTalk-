import type { Asset, AssetVersion, Rendition } from '@prisma/client';
import type { AssetDto, VersionDto } from '@frametalk/shared';
import { toJson } from '../util.js';

export function versionToDto(v: AssetVersion & { renditions?: Rendition[]; uploader?: { name: string } | null }): VersionDto {
  const rends = v.renditions ?? [];
  const sprite = rends.find((r) => r.kind === 'sprite');
  return {
    id: v.id,
    assetId: v.assetId,
    versionNo: v.versionNo,
    originalName: v.originalName,
    size: Number(v.size),
    mime: v.mime,
    status: v.status as VersionDto['status'],
    progress: v.progress,
    error: v.error,
    fpsNum: v.fpsNum,
    fpsDen: v.fpsDen,
    frameCount: v.frameCount,
    durationSec: v.durationSec,
    startTimecode: v.startTimecode,
    startFrames: v.startFrames,
    width: v.width,
    height: v.height,
    uploadedByName: v.uploader?.name ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    probe: toJson(v.probe),
    hasProxy: rends.some((r) => r.kind === 'proxy'),
    hasPoster: rends.some((r) => r.kind === 'poster'),
    sprite: sprite ? toJson(sprite.meta) : null,
  };
}

export function assetToDto(
  a: Asset & { versions?: (AssetVersion & { renditions?: Rendition[]; uploader?: { name: string } | null })[] },
): AssetDto {
  const versions = [...(a.versions ?? [])].sort((x, y) => y.versionNo - x.versionNo);
  const latest = versions[0];
  return {
    id: a.id,
    projectId: a.projectId,
    folderId: a.folderId,
    name: a.name,
    description: a.description,
    kind: a.kind as AssetDto['kind'],
    reviewStatus: a.reviewStatus as AssetDto['reviewStatus'],
    deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
    latestVersion: latest ? versionToDto(latest) : null,
    versionCount: versions.length,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
