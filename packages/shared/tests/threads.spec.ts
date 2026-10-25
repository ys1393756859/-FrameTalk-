import { describe, it, expect } from 'vitest';
import { buildCommentThreads, createCommentSchema, type CommentDto } from '../src/index.js';

function c(id: string, over: Partial<CommentDto> = {}): CommentDto {
  return {
    id, versionId: 'v1', parentId: null, authorId: `u-${id}`, authorName: `用户${id}`,
    frameIn: 0, frameOut: null, body: null, attachments: [], resolvedAt: null,
    createdAt: '2026-10-25T00:00:00.000Z', ...over,
  };
}

const t = (sec: number) => `2026-10-25T00:00:${String(sec).padStart(2, '0')}.000Z`;

describe('buildCommentThreads', () => {
  it('楼主与直接回复归组，楼层号从 2 起', () => {
    const threads = buildCommentThreads([
      c('A', { createdAt: t(1) }),
      c('B', { parentId: 'A', createdAt: t(2) }),
      c('C', { parentId: 'A', createdAt: t(3) }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.root.id).toBe('A');
    expect(threads[0]!.floors.map((f) => [f.comment.id, f.floor])).toEqual([['B', 2], ['C', 3]]);
    expect(threads[0]!.floors.every((f) => f.replyToName === null)).toBe(true);
  });

  it('回复的回复平铺进同一线程，replyToName 为直接父作者', () => {
    const threads = buildCommentThreads([
      c('A', { createdAt: t(1) }),
      c('B', { parentId: 'A', authorName: '乙', createdAt: t(2) }),
      c('D', { parentId: 'B', createdAt: t(3) }),
    ]);
    expect(threads).toHaveLength(1);
    const d = threads[0]!.floors.find((f) => f.comment.id === 'D')!;
    expect(d.floor).toBe(3);
    expect(d.replyToName).toBe('乙');
  });

  it('孤儿回复（父不在列表中）提升为楼主', () => {
    const threads = buildCommentThreads([
      c('A', { createdAt: t(1) }),
      c('E', { parentId: 'missing', createdAt: t(2) }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[1]!.root.id).toBe('E');
    expect(threads[1]!.floors).toHaveLength(0);
  });

  it('楼层按 createdAt 升序，与输入顺序无关', () => {
    const threads = buildCommentThreads([
      c('A', { createdAt: t(1) }),
      c('C', { parentId: 'A', createdAt: t(9) }),
      c('B', { parentId: 'A', createdAt: t(5) }),
    ]);
    expect(threads[0]!.floors.map((f) => f.comment.id)).toEqual(['B', 'C']);
  });

  it('楼主顺序保持输入顺序', () => {
    const threads = buildCommentThreads([
      c('A2', { frameIn: 50, createdAt: t(2) }),
      c('A1', { frameIn: 10, createdAt: t(1) }),
    ]);
    expect(threads.map((x) => x.root.id)).toEqual(['A2', 'A1']);
  });

  it('环引用不死循环', () => {
    // x↔y 互为父级（脏数据）：两者都不在 roots（父都在 map 中），但至少不能挂起
    const threads = buildCommentThreads([
      c('X', { parentId: 'Y' }),
      c('Y', { parentId: 'X' }),
    ]);
    expect(threads).toHaveLength(0);
  });
});

describe('createCommentSchema 回复帧号规则', () => {
  it('楼主缺 frameIn 拒绝', () => {
    expect(createCommentSchema.safeParse({ body: 'hi' }).success).toBe(false);
  });
  it('回复可省略 frameIn', () => {
    const r = createCommentSchema.safeParse({
      parentId: '00000000-0000-4000-8000-000000000000', body: 'hi',
    });
    expect(r.success).toBe(true);
  });
  it('frameIn 为 0 的楼主合法', () => {
    expect(createCommentSchema.safeParse({ frameIn: 0, drawing: { shapes: [] } }).success).toBe(true);
  });
});
