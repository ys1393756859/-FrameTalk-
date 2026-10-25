import type { ReactNode, MouseEvent } from 'react';
import { Button, Popconfirm, Tooltip } from 'antd';
import type { ButtonProps } from 'antd';

export interface IconActionProps extends Omit<ButtonProps, 'icon' | 'title' | 'onClick'> {
  /** 动作图标（必须，表格操作列禁止裸文字按钮） */
  icon: ReactNode;
  /** 悬浮提示（必须）：替代按钮文字说明动作含义 */
  tooltip: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** 填了则点击弹出二次确认，确认后才触发 onConfirm */
  confirm?: string;
  onConfirm?: () => void;
}

/**
 * 表格行操作按钮：图标 + Tooltip，禁止文字按钮。
 *
 * 规范（适用于所有表格操作列，写在这里避免重复犯错）：
 * 1. 操作列一律用 <IconAction icon tooltip>，不要 <Button>文字</Button>——
 *    文字按钮会把"操作"列挤得很宽，多操作时横向溢出。
 * 2. tooltip 必填：图标去掉文字后，唯一的信息载体就是 tooltip。
 * 3. 需要二次确认的危险操作传 confirm（内部包 Popconfirm），
 *    确认文案要写清后果（如"将删除全部素材，不可恢复"）。
 * 4. icon 用 @ant-design/icons 的Outlined线性图标，危险操作配 danger。
 */
export default function IconAction({ icon, tooltip, onClick, confirm, onConfirm, danger, ...btnProps }: IconActionProps) {
  const btn = (
    <Tooltip title={tooltip}>
      <Button size="small" type="text" icon={icon} danger={danger} onClick={onClick} {...btnProps} />
    </Tooltip>
  );
  if (confirm) {
    return <Popconfirm title={confirm} onConfirm={onConfirm}>{btn}</Popconfirm>;
  }
  return btn;
}
