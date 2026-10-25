import { useState } from 'react';
import { Button, Input, Modal, Popover, Tag, Tooltip, message } from 'antd';
import { TagOutlined, PlusOutlined } from '@ant-design/icons';
import {
  COMMENT_LABELS, COMMENT_LABEL_TEXT, BUILTIN_LABEL_COLORS, LABEL_PALETTE,
  type CommentLabel, type CustomLabel,
} from '@frametalk/shared';

/* 批注标签选择器：内置（紧急/建议/参考）+ 项目自定义标签；管理者可新建（名称≤10 + 色板） */
export function LabelPicker({
  value, onChange, customLabels, onAddCustom, canManage, disabled,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  customLabels: CustomLabel[];
  onAddCustom: (label: CustomLabel) => Promise<void> | void;
  canManage: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_PALETTE[0]);
  const [saving, setSaving] = useState(false);

  const all: { key: string; text: string; color: string }[] = [
    ...COMMENT_LABELS.map((l) => ({ key: l as string, text: COMMENT_LABEL_TEXT[l], color: BUILTIN_LABEL_COLORS[l] })),
    ...customLabels.map((c) => ({ key: c.name, text: c.name, color: c.color })),
  ];

  const toggle = (key: string) => {
    onChange(value.includes(key) ? value.filter((x) => x !== key) : [...value, key].slice(0, 5));
  };

  const submitNew = async () => {
    const n = name.trim();
    if (!n) return message.warning('请输入标签名称');
    if (all.some((l) => l.text === n)) return message.warning('标签已存在');
    setSaving(true);
    try {
      await onAddCustom({ name: n, color });
      onChange([...value, n].slice(0, 5));
      setCreating(false); setName(''); setColor(LABEL_PALETTE[0]);
    } finally { setSaving(false); }
  };

  const content = (
    <div style={{ width: 260 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {all.map((l) => (
          <Tag.CheckableTag
            key={l.key} checked={value.includes(l.key)} onChange={() => toggle(l.key)}
            style={value.includes(l.key)
              ? { background: l.color, borderColor: l.color, color: '#fff' }
              : { borderColor: l.color, color: l.color }}
          >
            {l.text}
          </Tag.CheckableTag>
        ))}
      </div>
      {canManage && (
        <Button
          size="small" type="dashed" block icon={<PlusOutlined />}
          style={{ marginTop: 8 }}
          onClick={() => setCreating(true)}
        >新建标签</Button>
      )}
      <Modal
        title="新建批注标签" open={creating} onCancel={() => setCreating(false)}
        onOk={submitNew} confirmLoading={saving} okText="确定" cancelText="取消" destroyOnClose
      >
        <div style={{ marginBottom: 8 }}>标签名称</div>
        <Input
          value={name} maxLength={10} placeholder="请输入标签名称"
          suffix={<span style={{ color: '#999' }}>{name.length}/10</span>}
          onChange={(e) => setName(e.target.value)}
        />
        <div style={{ margin: '12px 0 8px' }}>颜色</div>
        <div style={{ display: 'flex', gap: 10 }}>
          {LABEL_PALETTE.map((c) => (
            <div
              key={c} onClick={() => setColor(c)}
              style={{
                width: 26, height: 16, borderRadius: 3, background: c, cursor: 'pointer',
                outline: color === c ? '2px solid #fff' : 'none', outlineOffset: 1,
                boxShadow: color === c ? `0 0 0 3px ${c}55` : undefined,
              }}
            />
          ))}
        </div>
      </Modal>
    </div>
  );

  return (
    <Popover
      content={content} trigger="click" open={open} onOpenChange={(o) => !disabled && setOpen(o)}
      placement="topRight"
    >
      <Tooltip title="标签">
        <Button
          size="small" type="text" icon={<TagOutlined />} disabled={disabled}
          style={value.length ? { color: '#4f7cff' } : undefined}
        />
      </Tooltip>
    </Popover>
  );
}

/** 标签显示色：内置映射 → 自定义 → 灰 */
export function labelColor(name: string, customLabels: CustomLabel[]): string {
  const builtin = BUILTIN_LABEL_COLORS[name as CommentLabel];
  if (builtin) return builtin;
  return customLabels.find((c) => c.name === name)?.color ?? '#8c8c8c';
}

export function labelText(name: string): string {
  return (COMMENT_LABEL_TEXT as Record<string, string>)[name] ?? name;
}
