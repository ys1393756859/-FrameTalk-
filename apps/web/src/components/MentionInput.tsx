import { useMemo, useRef, useState } from 'react';
import { Avatar, Button } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { renderWithMentions } from './mentionText';

export interface MentionMember {
  userId: string;
  name: string;
  role?: string;
  email?: string | null;
}

/* ---------------- @提及输入框：输入 @ 弹出人员下拉，选中插入 @姓名 ---------------- */

export function MentionInput({
  value, onChange, mentions, setMentions, members, placeholder, rows, disabled, inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  mentions: string[];
  setMentions: (m: string[]) => void;
  members: MentionMember[];
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** 外部持有 textarea 引用（表情等工具在光标处插入用） */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  // @ 触发词：最后一个未闭合的 @xxx（@ 后到光标前的文本）
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  // IME 组合输入期间让 textarea 文字可见（透明文字会导致拼音候选看不见）
  const [composing, setComposing] = useState(false);
  const memberNames = useMemo(() => members.map((m) => m.name), [members]);

  const closeDropdown = () => setTrigger(null);

  const detectTrigger = (text: string, caret: number) => {
    // 从光标往前找 @，中间不能有空格/换行（触发词是连续的）
    const before = text.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return null;
    const word = before.slice(at + 1);
    if (/[\s@]/.test(word)) return null;
    return { start: at, query: word };
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const next = el.value;
    onChange(next);
    const t = detectTrigger(next, el.selectionStart ?? next.length);
    setTrigger(t);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && (e.key === 'Escape' || e.key === ' ')) closeDropdown();
  };

  const filtered = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(q) || m.userId.includes(q)).slice(0, 8);
  }, [trigger, members]);

  const pickMember = (m: MentionMember) => {
    if (!trigger) return;
    // 用零宽空格结尾，避免选完后再次触发检测
    const insert = `@${m.name}\u200b`;
    const next = value.slice(0, trigger.start) + insert + value.slice(trigger.start + 1 + trigger.query.length);
    onChange(next);
    if (!mentions.includes(m.userId)) setMentions([...mentions, m.userId]);
    closeDropdown();
    // 光标移到插入内容后
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      const pos = trigger.start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const insertAt = () => {
    // 点 @ 按钮：在光标处插入 @ 并触发下拉
    const el = areaRef.current;
    const caret = el ? (el.selectionStart ?? value.length) : value.length;
    const next = value.slice(0, caret) + '@' + value.slice(caret);
    onChange(next);
    setTrigger({ start: caret, query: '' });
    requestAnimationFrame(() => {
      const el2 = areaRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(caret + 1, caret + 1);
    });
  };

  // 输入框与高亮垫层必须字体/行高/内边距/滚动条槽完全一致，两层文字才能像素级重合
  const layerTypography: React.CSSProperties = {
    padding: '4px 36px 4px 8px', fontFamily: 'inherit', fontSize: 14, lineHeight: '20px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', scrollbarGutter: 'stable',
  };

  return (
    <div style={{ position: 'relative' }}>
      <Button
        size="small" type="text" icon={<UserOutlined />} disabled={disabled}
        onClick={insertAt}
        style={{ position: 'absolute', right: 4, top: 4, zIndex: 3, color: '#888' }}
        title="@提及"
      />
      <div style={{ position: 'relative', background: '#141414', border: '1px solid #424242', borderRadius: 6 }}>
        {/* 垫层：渲染真正可见的文字，@提及高亮成蓝色；textarea 文字透明只出光标 */}
        <div
          ref={backdropRef}
          aria-hidden
          style={{
            ...layerTypography,
            position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
            color: 'rgba(255,255,255,0.88)', borderRadius: 6,
          }}
        >
          {renderWithMentions(value, memberNames)}
        </div>
        <textarea
          ref={(el) => {
            areaRef.current = el;
            if (inputRef) inputRef.current = el;
          }}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={(e) => { if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop; }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onBlur={(e) => { if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.mention-dropdown')) closeDropdown(); }}
          placeholder={placeholder}
          rows={rows ?? 3}
          disabled={disabled}
          style={{
            ...layerTypography,
            display: 'block', position: 'relative', width: '100%',
            background: 'transparent', border: 'none', borderRadius: 6,
            color: composing ? 'rgba(255,255,255,0.88)' : 'transparent',
            caretColor: '#4f9dff', resize: 'vertical', outline: 'none',
          }}
        />
      </div>
      {trigger && filtered.length > 0 && (
        <div
          className="mention-dropdown"
          style={{
            position: 'absolute', left: 0, right: 0, bottom: '100%', zIndex: 10,
            background: '#1f1f1f', border: '1px solid #424242', borderRadius: 6,
            maxHeight: 240, overflow: 'auto', marginBottom: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          {filtered.map((m) => (
            <div
              key={m.userId}
              onMouseDown={(e) => { e.preventDefault(); pickMember(m); }}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a2a')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Avatar size={20} style={{ background: '#4f7cff', fontSize: 11, flexShrink: 0 }}>{m.name[0]}</Avatar>
              <span style={{ fontSize: 13 }}>{m.name}</span>
              {m.email && <span style={{ color: '#666', fontSize: 12 }}>{m.email}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
