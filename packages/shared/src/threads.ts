import type { CommentDto } from './api-types.js';

/* ---------- 评论线程归组（两级楼层式） ----------
 * 数据层 parentId 指向直接回复目标（楼主或某一层），展示层归组为
 * 「楼主 + 平铺楼层」：所有后代回复挂在所属根线程下，按时间排楼层号；
 * 回复的直接父级不是楼主时，replyToName 用于渲染「回复 @某人」。
 */

export interface CommentFloor {
  comment: CommentDto;
  /** 楼层号：楼主为 1 楼，回复从 2 楼起 */
  floor: number;
  /** 直接回复的是楼内其他层时，为该作者姓名；直接回复楼主则为 null */
  replyToName: string | null;
}

export interface CommentThread {
  root: CommentDto;
  /** 楼内全部楼层，createdAt 升序 */
  floors: CommentFloor[];
}

/**
 * 把平铺评论列表归组成两级楼层线程。
 * - parentId 为空、或父评论不在列表中（孤儿，父被删）的评论视为楼主；
 * - 楼主顺序保持输入顺序（调用方先排好序）；
 * - 后代沿 parentId 链收集（含对回复的回复），环引用安全截断。
 */
export function buildCommentThreads(comments: CommentDto[]): CommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const childrenOf = new Map<string, CommentDto[]>();
  const roots: CommentDto[] = [];
  for (const c of comments) {
    if (c.parentId == null || !byId.has(c.parentId)) {
      roots.push(c);
      continue;
    }
    const arr = childrenOf.get(c.parentId);
    if (arr) arr.push(c);
    else childrenOf.set(c.parentId, [c]);
  }

  const threads: CommentThread[] = [];
  for (const root of roots) {
    const desc: CommentDto[] = [];
    const seen = new Set<string>([root.id]);
    const queue = [root.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        desc.push(child);
        queue.push(child.id);
      }
    }
    desc.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    threads.push({
      root,
      floors: desc.map((c, i) => {
        const p = c.parentId ? byId.get(c.parentId) : null;
        return {
          comment: c,
          floor: i + 2,
          replyToName: p && p.id !== root.id ? p.authorName : null,
        };
      }),
    });
  }
  return threads;
}
