import type React from 'react';

/* ---------------- @提及高亮：批注展示与输入框垫层共用 ---------------- */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 构造 @提及匹配正则。两种形态：
 * 1. 下拉选中的提及以零宽空格结尾（MentionInput 插入 `@姓名\u200b`），用 ZWSP 作终结符精确截断；
 * 2. 手打的 `@姓名`（无 ZWSP）按已知成员名匹配，长名优先，后面不能再跟字词字符。
 * 负向后行断言排除邮箱 user@example.com 的误匹配。
 */
/** 缓存正则源码（调用方用 useMemo 稳定 names 引用时命中）；'g' 正则有 lastIndex 状态，每次新建实例 */
const sourceCache = new WeakMap<string[], string>();

export function mentionRegex(names?: string[]): RegExp {
  const zwspTerm = '[^\\s@\\u200b]+\\u200b';
  if (!names || names.length === 0) {
    return new RegExp(`(?<![A-Za-z0-9_])@${zwspTerm}`, 'g');
  }
  let source = sourceCache.get(names);
  if (!source) {
    const sorted = [...new Set(names)].sort((a, b) => b.length - a.length).map(escapeRe);
    // 名字后不跟 ASCII 字词字符即可（防 bob 命中 bobby）；中文正文里名字后常直接跟汉字，不能再限 CJK
    const named = `(?:${sorted.join('|')})(?:\\u200b|(?![A-Za-z0-9_]))`;
    source = `(?<![A-Za-z0-9_])@(?:${named}|${zwspTerm})`;
    sourceCache.set(names, source);
  }
  return new RegExp(source, 'g');
}

/** 提及的统一视觉：品牌蓝 + 加粗，与「回复 @某人」样式一致 */
export const MENTION_STYLE: React.CSSProperties = {
  color: '#4f9dff',
  fontWeight: 600,
};

/**
 * 把纯文本切成「普通段 + @提及高亮段」。无提及时原样返回字符串（零额外节点）。
 */
export function renderWithMentions(text: string, names?: string[]): React.ReactNode {
  const re = mentionRegex(names);
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} style={MENTION_STYLE}>{m[0]}</span>,
    );
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
