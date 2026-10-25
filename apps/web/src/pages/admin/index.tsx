import { useState } from 'react';
import {
  App, Button, Card, Form, Input, Modal, Popconfirm, Progress, Select, Space, Switch,
  Table, Tag, Tabs, Statistic, Descriptions, DatePicker, Alert,
} from 'antd';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes } from '../../api';
import type { SessionUser } from '@frametalk/shared';
import { USER_TITLES } from '@frametalk/shared';
import DataTable from '../../components/DataTable';
import IconAction from '../../components/IconAction';
import { Link, Outlet } from 'react-router';
import { DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, RedoOutlined } from '@ant-design/icons';

/* ================= 用户管理 ================= */
export function AdminUsers({ me }: { me: SessionUser }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ users: any[] }>('/api/users'),
  });

  const create = useMutation({
    mutationFn: (v: any) => api('/api/users', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => { message.success('已创建，首次登录将强制改密'); setCreateOpen(false); form.resetFields(); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, ...v }: any) => api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => { message.success('已更新'); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => message.error(e.message),
  });

  /* 编辑弹窗：改姓名 / 邮箱 / 密码（form 是持久实例，打开时显式写入旧值；密码留空 = 不修改） */
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const openEdit = (u: any) => {
    setEditingUser(u);
    editForm.setFieldsValue({ name: u.name, email: u.email ?? undefined, phone: u.phone ?? undefined, title: u.title ?? undefined, newPassword: undefined });
    setEditOpen(true);
  };

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => { message.success('用户已删除'); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => message.error(e.message),
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 1000, width: '100%', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ flexShrink: 0 }}>用户管理</h3>
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建账号</Button>
      </div>
      <DataTable<any>
        rowKey="id" loading={users.isPending}
        data={users.data?.users ?? []}
        columns={[
          { title: '姓名', dataIndex: 'name', width: 110, ellipsis: true },
          { title: '手机号', dataIndex: 'phone', width: 130, render: (v: string | null) => v || '—' },
          { title: '职位', dataIndex: 'title', width: 130, render: (v: string | null, u: any) => (
            <Select
              size="small" allowClear placeholder="设职位" value={v ?? undefined} style={{ width: 96 }}
              options={USER_TITLES.map((t) => ({ value: t, label: t }))}
              onChange={(title) => update.mutate({ id: u.id, title: title ?? null })}
            />
          ) },
          { title: '管理员', dataIndex: 'isAdmin', render: (v: boolean, u: any) => (
            <Switch checked={v} disabled={u.id === me.id}
              onChange={(isAdmin) => update.mutate({ id: u.id, isAdmin })} />
          ) },
          { title: '状态', dataIndex: 'disabled', render: (v: boolean) => v ? <Tag color="error">已禁用</Tag> : <Tag color="success">正常</Tag> },
          { title: '项目数', dataIndex: 'projectCount', width: 80 },
          { title: '操作', width: 170, render: (_: any, u: any) => (
            /* 表格操作规范：一律 IconAction（图标+tooltip），禁止文字按钮（见 components/IconAction.tsx） */
            <Space>
              <IconAction icon={<EditOutlined />} tooltip="编辑（姓名/邮箱/手机号/职位/密码）" onClick={() => openEdit(u)} />
              <IconAction
                icon={u.disabled ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                tooltip={u.disabled ? '启用账号' : '禁用账号（立即踢下线）'}
                danger={!u.disabled}
                confirm={u.disabled ? undefined : '禁用后立即踢下线，确认？'}
                onConfirm={() => update.mutate({ id: u.id, disabled: !u.disabled })}
                onClick={u.disabled ? () => update.mutate({ id: u.id, disabled: false }) : undefined}
              />
              {u.id !== me.id && (
                <IconAction
                  icon={<DeleteOutlined />} tooltip="删除用户" danger
                  confirm={`删除用户 ${u.name}？项目成员身份、批注、通知一并清除，不可恢复`}
                  onConfirm={() => remove.mutate(u.id)}
                />
              )}
            </Space>
          ) },
        ] as any}
      />
      <Modal title="新建账号" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending}>
        <Form form={form} layout="vertical"
          onFinish={(v) => {
            if (!v.email && !v.phone) { message.error('邮箱和手机号至少填一个'); return; }
            create.mutate({ ...v, email: v.email || undefined, phone: v.phone || undefined });
          }}
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}><Input placeholder="选填" /></Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ pattern: /^1\d{10}$/, message: '11 位手机号' }]}><Input placeholder="选填，与邮箱至少填一个" maxLength={11} /></Form.Item>
          <Form.Item name="title" label="职位">
            <Select allowClear placeholder="选择职位" options={USER_TITLES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}><Input.Password /></Form.Item>
          <Form.Item name="isAdmin" label="系统管理员" valuePropName="checked" initialValue={false}><Switch /></Form.Item>
        </Form>
      </Modal>

      {/* 编辑：改姓名 / 邮箱 / 职位（独立 form 实例，避免和新建弹窗互相残留） */}
      <Modal
        title={`编辑用户：${editingUser?.name ?? ''}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => editForm.submit()}
        confirmLoading={update.isPending}
        okText="保存"
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) => {
            if (!editingUser) return;
            const nextEmail = v.email || null;
            const nextPhone = v.phone || null;
            if (!nextEmail && !nextPhone) { message.error('邮箱和手机号至少保留一个'); return; }
            update.mutate({
              id: editingUser.id,
              name: v.name,
              email: (nextEmail ?? null) !== (editingUser.email ?? null) ? nextEmail : undefined,
              phone: (nextPhone ?? null) !== (editingUser.phone ?? null) ? nextPhone : undefined,
              title: v.title ?? null,
              // 留空不提交该字段 = 密码保持不变
              newPassword: v.newPassword ? v.newPassword : undefined,
            });
          }}
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}><Input placeholder="选填" /></Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ pattern: /^1\d{10}$/, message: '11 位手机号' }]}><Input maxLength={11} /></Form.Item>
          <Form.Item name="title" label="职位">
            <Select allowClear placeholder="选择职位" options={USER_TITLES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ min: 8, message: '至少 8 位' }]}>
            <Input.Password placeholder="留空则不修改" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ================= 项目总览 ================= */
export function AdminOverview() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const data = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<any>('/api/admin/overview'),
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: any) => api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ archived }) }),
    onSuccess: () => { message.success('已更新'); qc.invalidateQueries({ queryKey: ['admin-overview'] }); },
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <h3 style={{ flexShrink: 0 }}>项目总览</h3>
      <Space style={{ marginBottom: 16 }}>
        <Statistic title="项目数" value={data.data?.projects?.length ?? 0} />
        <Statistic title="版本占用" value={formatBytes(data.data?.totals?.versionBytes ?? 0)} />
        <Statistic title="转码产物占用" value={formatBytes(data.data?.totals?.renditionBytes ?? 0)} />
      </Space>
      <DataTable<any>
        rowKey="id" loading={data.isPending} data={data.data?.projects ?? []}
        columns={[
          { title: '项目', dataIndex: 'name', width: 180, render: (v: any, p: any) => <Link to={`/p/${p.id}`}>{v}</Link> },
          { title: '负责人', dataIndex: 'managers', width: 140, render: (v: string[]) => v.join('、') || '-' },
          { title: '成员', dataIndex: 'memberCount', width: 80 },
          { title: '资产', dataIndex: 'assetCount', width: 80 },
          { title: '占用', dataIndex: 'bytes', render: (v: number) => formatBytes(v) },
          { title: '最近操作人', dataIndex: 'lastActor', width: 110, render: (v: string | null) => v || '-' },
          { title: '最近活动', dataIndex: 'lastActivity', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
          { title: '状态', width: 90, render: (_: any, p: any) => p.archived ? <Tag>已归档</Tag> : <Tag color="green">活跃</Tag> },
          { title: '操作', width: 80, render: (_: any, p: any) => (
            <IconAction
              icon={p.archived ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              tooltip={p.archived ? '恢复项目' : '归档项目'}
              onClick={() => archive.mutate({ id: p.id, archived: !p.archived })}
            />
          ) },
        ] as any}
      />
    </div>
  );
}

/* ================= 存储监控 ================= */
export function AdminStorage() {
  const data = useQuery({
    queryKey: ['admin-storage'],
    queryFn: () => api<any>('/api/admin/storage'),
    refetchInterval: 30_000,
  });
  const disk = data.data?.disk;
  const used = disk ? disk.total - disk.free : 0;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 900, width: '100%', margin: '0 auto' }}>
      <h3 style={{ flexShrink: 0 }}>存储监控</h3>
      {data.data?.lowSpace && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="磁盘剩余低于 15%" />}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small" style={{ marginBottom: 12 }}>
          <Descriptions.Item label="原片归档存储">{data.data?.storageBackend ?? 'local'}</Descriptions.Item>
        </Descriptions>
        {disk ? (
          <>
            <Progress percent={Math.round((used / disk.total) * 100)} status={data.data.lowSpace ? 'exception' : 'normal'} />
            <Descriptions column={3} size="small">
              <Descriptions.Item label="总量">{formatBytes(disk.total)}</Descriptions.Item>
              <Descriptions.Item label="已用">{formatBytes(used)}</Descriptions.Item>
              <Descriptions.Item label="剩余">{formatBytes(disk.free)}</Descriptions.Item>
            </Descriptions>
            <div style={{ color: '#888', fontSize: 12 }}>与 du -sh 对账：上表为 statfs 文件系统口径（含数据库等所有占用）</div>
          </>
        ) : '无法读取磁盘信息'}
      </Card>
      <DataTable<any>
        rowKey="id" size="small" loading={data.isPending}
        data={data.data?.projects ?? []}
        columns={[
          { title: '项目', dataIndex: 'name', width: 240 },
          { title: '原片占用', width: 140, dataIndex: 'bytes', render: (v: number) => formatBytes(v) },
        ] as any}
        pagination={false}
      />
    </div>
  );
}

/* ================= 转码任务 ================= */
export function AdminTranscodes() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const data = useQuery({
    queryKey: ['admin-transcodes'],
    queryFn: () => api<any>('/api/admin/transcodes'),
    refetchInterval: 5000,
  });
  const retry = useMutation({
    mutationFn: (versionId: string) => api(`/api/admin/transcodes/${versionId}/retry`, { method: 'POST' }),
    onSuccess: () => { message.success('已重新排队'); qc.invalidateQueries({ queryKey: ['admin-transcodes'] }); },
  });
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <h3 style={{ flexShrink: 0 }}>转码任务</h3>
      <DataTable<any>
        rowKey="versionId" loading={data.isPending} data={data.data?.tasks ?? []}
        columns={[
          { title: '资产', dataIndex: 'assetName', width: 200 },
          { title: '版本', dataIndex: 'versionNo', width: 70 },
          { title: '状态', dataIndex: 'status', width: 110, render: (s: string, t: any) =>
            s === 'transcoding' || s === 'queued' ? <Progress percent={t.progress} size="small" />
            : <Tag color="error">失败</Tag> },
          { title: '大小', width: 90, dataIndex: 'size', render: (v: number) => formatBytes(v) },
          { title: '上传者', width: 100, dataIndex: 'uploadedBy' },
          { title: '时间', width: 170, dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
          { title: '操作', width: 80, render: (_: any, t: any) => (
            <IconAction
              icon={<RedoOutlined />} tooltip="重新排队转码" disabled={t.status !== 'failed'}
              onClick={() => retry.mutate(t.versionId)}
            />
          ) },
        ] as any}
      />
    </div>
  );
}

/* ================= 审计日志 ================= */
/** action 英文码 → 中文名。筛选下拉和表格列共用；新增审计点时在这里补一行 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'login': '登录',
  'logout': '退出登录',
  'download': '下载原片',
  'download.zip': '批量下载',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'member.add': '添加成员',
  'member.remove': '移除成员',
  'member.role': '变更成员角色',
  'project.create': '创建项目',
  'project.update': '更新项目',
  'project.delete': '删除项目',
  'asset.trash': '素材入回收站',
  'comment.delete': '删除批注',
  'transcode.retry': '重试转码',
  'export.csv': '导出 CSV',
  'export.edl': '导出 EDL',
  'export.xml': '导出 XML',
  'export.pdf': '导出 PDF',
  'password.change': '修改密码',
  'settings.update': '更新系统设置',
  'episode.create': '创建剧集', // 已下线，历史数据仍需显示
  'episode.update': '更新剧集',
  'episode.delete': '删除剧集',
};
const AUDIT_ACTIONS = Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }));

export function AdminAudit() {
  const [actorId, setActorId] = useState<string | undefined>();
  const [action, setAction] = useState<string>();
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ users: any[] }>('/api/users'),
  });
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <h3 style={{ flexShrink: 0 }}>审计日志</h3>
      <DataTable<any>
        rowKey="id"
        size="small"
        emptyText="暂无日志"
        queryKey={['admin-audit', actorId ?? '', action ?? '']}
        fetcher={async ({ page, pageSize }) => {
          const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
          if (actorId) p.set('actorId', actorId);
          if (action) p.set('action', action);
          const r = await api<{ items: any[]; total: number }>(`/api/admin/audit?${p}`);
          return { items: r.items, total: r.total };
        }}
        toolbar={<>
          <Select
            allowClear placeholder="按人筛选" style={{ width: 200 }} value={actorId} onChange={setActorId}
            options={(users.data?.users ?? []).map((u: any) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
            showSearch optionFilterProp="label"
          />
          <Select
            allowClear placeholder="按操作筛选" style={{ width: 180 }} value={action} onChange={setAction}
            options={AUDIT_ACTIONS}
          />
        </>}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
          { title: '操作人', width: 100, render: (_: any, i: any) => i.actorName ?? '-' },
          { title: '操作', dataIndex: 'action', width: 130, render: (v: string) => <Tag>{AUDIT_ACTION_LABELS[v] ?? v}</Tag> },
          { title: '对象', dataIndex: 'target', ellipsis: true },
          { title: 'IP', dataIndex: 'ip', width: 130 },
        ] as any}
      />
    </div>
  );
}
