import { describe, it, expect } from 'vitest';
import { roleAtLeast, PROJECT_ROLES, type ProjectRole } from '@frametalk/shared';

/** 权限矩阵：角色 -> 允许的最低要求档位（表驱动，改权限时先改这张表） */
const MATRIX: Record<ProjectRole | 'admin', ProjectRole[]> = {
  manager: ['manager', 'editor', 'reviewer', 'viewer'],
  editor: ['editor', 'reviewer', 'viewer'],
  reviewer: ['reviewer', 'viewer'],
  viewer: ['viewer'],
  admin: ['manager', 'editor', 'reviewer', 'viewer'],
};

/** 各业务动作要求的最低角色（文档 5.5：管理者>编辑>审阅>只读） */
const ACTION_REQUIREMENTS: Record<string, ProjectRole> = {
  '查看/播放媒体': 'viewer',
  '下载原片/批量zip': 'viewer',
  '评论/标记已解决/改审阅状态': 'reviewer',
  '上传/重命名/移动/回收站': 'editor',
  '建文件夹/删文件夹': 'editor',
  '管理成员/编辑项目/删除项目': 'manager',
};

describe('权限矩阵', () => {
  for (const [actual, allowed] of Object.entries(MATRIX) as [ProjectRole | 'admin', ProjectRole[]][]) {
    for (const required of PROJECT_ROLES) {
      const expectOk = allowed.includes(required);
      it(`${actual} 要求 ${required} -> ${expectOk ? '允许' : '拒绝'}`, () => {
        expect(roleAtLeast(actual, required)).toBe(expectOk);
      });
    }
  }

  it('动作->最低角色 与矩阵一致', () => {
    const REQ = ACTION_REQUIREMENTS as Record<string, ProjectRole>;
    // 审阅者不能上传
    expect(roleAtLeast('reviewer', REQ['上传/重命名/移动/回收站']!)).toBe(false);
    // 只读不能评论
    expect(roleAtLeast('viewer', REQ['评论/标记已解决/改审阅状态']!)).toBe(false);
    // 审阅及以上可改审阅状态
    for (const role of ['reviewer', 'editor', 'manager', 'admin'] as const) {
      expect(roleAtLeast(role, REQ['评论/标记已解决/改审阅状态']!)).toBe(true);
    }
    // 任意成员可看媒体
    for (const role of [...PROJECT_ROLES, 'admin'] as const) {
      expect(roleAtLeast(role, REQ['查看/播放媒体']!)).toBe(true);
    }
    // 只有管理者能管成员
    expect(roleAtLeast('editor', REQ['管理成员/编辑项目/删除项目']!)).toBe(false);
    expect(roleAtLeast('manager', REQ['管理成员/编辑项目/删除项目']!)).toBe(true);
  });
});
