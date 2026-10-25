import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { renderWithMentions } from './mentionText';

/**
 * 长文本折叠：超过 maxLines 行时截断（-webkit-line-clamp），显示「展开全文/收起」。
 * 是否溢出按渲染后的 scrollHeight 实测，短文本不会出现无用按钮。
 * @提及以蓝色高亮渲染（传 mentionNames 可额外匹配手打的成员名）。
 */
export default function CollapsibleText({ text, maxLines = 6, fontSize = 13, color, mentionNames }: {
  text: string;
  maxLines?: number;
  fontSize?: number;
  color?: string;
  mentionNames?: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (expanded) return; // 展开态不重测，保留收起时得出的判定
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, maxLines, expanded]);

  const base: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize, color };
  const clamped: React.CSSProperties = expanded ? base : {
    ...base,
    display: '-webkit-box',
    WebkitLineClamp: maxLines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };

  return (
    <div>
      <div ref={ref} style={clamped}>{renderWithMentions(text, mentionNames)}</div>
      {overflowing && (
        <Button
          type="link" size="small"
          style={{ padding: 0, height: 'auto', fontSize: 12 }}
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {expanded ? '收起' : '展开全文'}
        </Button>
      )}
    </div>
  );
}
