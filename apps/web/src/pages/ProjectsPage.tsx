import { useEffect, useState } from 'react';
import { Card, Button, Modal, Form, Input, App, Empty, Segmented, Tag, Tooltip, Dropdown, Popconfirm, Radio, Select } from 'antd';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { ProjectSummary, SessionUser, ProjectKind } from '@frametalk/shared';
import { PlusOutlined, AppstoreOutlined, BarsOutlined, TeamOutlined, FolderOpenOutlined, UserOutlined, MoreOutlined, EditOutlined, StopOutlined, DeleteOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable';

type ViewMode = 'grid' | 'table';
const VIEW_KEY = 'ft-projects-view';
const KIND_FILTER_KEY = 'ft-projects-kind';
const KIND_LABEL: Record<ProjectKind, string> = { self: '自制', external: '外部' };

export default function ProjectsPage({ user }: { user: SessionUser }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const [form] = Form.useForm();
  const [view, setView] = useState<ViewMode>(() =>
    (localStorage.getItem(VIEW_KEY) as ViewMode) || 'grid');
  const [kindFilter, setKindFilter] = useState<'all' | ProjectKind>(() =>
    (localStorage.getItem(KIND_FILTER_KEY) as 'all' | ProjectKind) || 'all');

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem(KIND_FILTER_KEY, kindFilter);
  }, [kindFilter]);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: ProjectSummary[] }>('/api/projects'),
  });

  const create = useMutation({
    mutationFn: (v: { name: string; kind?: ProjectKind; description?: string }) =>
      api<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (res) => {
      message.success('项目已创建');
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['projects'] });
      nav(`/p/${res.id}`);
    },
    onError: (e: any) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; kind?: ProjectKind; description?: string; archived?: boolean }) => {
      const { id, ...body } = v;
      return api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      message.success('已保存');
      setOpen(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: any) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      message.success('项目已删除');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: any) => message.error(e.message),
  });

  const canManage = (p: ProjectSummary) => user.isAdmin || p.myRole === 'manager';

  const openEdit = (p: ProjectSummary) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, kind: p.kind ?? 'self', description: p.description ?? '' });
    setOpen(true);
  };
  const list = (projects.data?.projects ?? []).filter((p) => kindFilter === 'all' || (p.kind ?? 'self') === kindFilter);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 24, maxWidth: 1200, width: '100%', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
        <h3 style={{ margin: 0 }}>项目（{list.length}）</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Select
            value={kindFilter}
            onChange={(v) => setKindFilter(v)}
            style={{ width: 100 }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'self', label: '自制' },
              { value: 'external', label: '外部' },
            ]}
          />
          <Segmented
            value={view}
            onChange={(v) => setView(v as ViewMode)}
            options={[
              { value: 'grid', icon: <AppstoreOutlined />, label: '宫格' },
              { value: 'table', icon: <BarsOutlined />, label: '表格' },
            ]}
          />
          {user.isAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setOpen(true); }}>新建项目</Button>
          )}
        </div>
      </div>

      {projects.isPending && <Card loading style={{ flex: 1 }} />}

      {!projects.isPending && list.length === 0 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description={user.isAdmin ? '还没有项目，点右上角新建' : '你还没有被加入任何项目'} />
        </div>
      )}

      {/* ---------- 宫格视图 ---------- */}
      {view === 'grid' && list.length > 0 && (
        <div
          style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16, alignContent: 'start',
          }}
        >
          {list.map((p) => {
            const kind = p.kind ?? 'self';
            return (
            <Card
              key={p.id}
              hoverable
              onClick={() => nav(`/p/${p.id}`)}
              styles={{ body: { padding: '14px 16px' } }}
            >
              <div style={{
                position: 'absolute', bottom: 0, right: 0,
                padding: '1px 10px', borderRadius: '8px 0 0 0',
                fontSize: 12, lineHeight: '20px', color: '#fff', pointerEvents: 'none',
                background: kind === 'self' ? 'linear-gradient(135deg, #4f7cff, #2f5ce6)' : 'linear-gradient(135deg, #fa8c16, #d46b08)',
              }}>
                {KIND_LABEL[kind]}
              </div>
              <Card.Meta
                avatar={
                  <div style={{
                    width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'linear-gradient(135deg, #4f7cff33, #4f7cff11)', color: '#4f7cff',
                  }}>
                    <FolderOpenOutlined style={{ fontSize: 20 }} />
                  </div>
                }
                title={
                  <span style={{ fontSize: 14, display: 'flex', alignItems: 'center' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    {p.archivedAt && <Tag style={{ marginLeft: 8 }}>已归档</Tag>}
                    {canManage(p) && (
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            {
                              key: 'edit', icon: <EditOutlined />, label: '编辑（重命名）',
                              // Dropdown 菜单虽是弹层，但 React 树上仍是 Card 的子节点：
                              // 不拦截 domEvent 冒泡的话，点菜单项会同时触发 Card 的 onClick 跳进详情页
                              onClick: (info) => { info.domEvent?.stopPropagation(); openEdit(p); },
                            },
                            {
                              key: 'archive', icon: <StopOutlined />,
                              label: p.archivedAt ? '取消归档' : '归档',
                              onClick: (info) => { info.domEvent?.stopPropagation(); update.mutate({ id: p.id, archived: !p.archivedAt }); },
                            },
                            {
                              key: 'delete', icon: <DeleteOutlined />, danger: true, label: '删除项目',
                              onClick: (info) => {
                                info.domEvent?.stopPropagation();
                                modal.confirm({
                                  title: '删除项目？',
                                  content: `将同时删除「${p.name}」的全部素材文件与批注，不可恢复`,
                                  okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
                                  onOk: () => remove.mutate(p.id),
                                });
                              },
                            },
                          ],
                        }}
                      >
                        <Button size="small" type="text" icon={<MoreOutlined />}
                          onClick={(e) => e.stopPropagation()} />
                      </Dropdown>
                    )}
                  </span>
                }
                description={
                  <div style={{ minHeight: 34, color: '#888', fontSize: 12, lineHeight: '17px' }}>
                    {(p.description || '—').slice(0, 42)}
                  </div>
                }
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 10, color: '#8c8c8c', fontSize: 12 }}>
                <Tooltip title="成员数"><span><TeamOutlined style={{ marginRight: 4 }} />{p.memberCount}</span></Tooltip>
                <Tooltip title="我的角色">
                  <span><UserOutlined style={{ marginRight: 4 }} />
                    {p.myRole === 'admin' ? '管理员' : p.myRole === 'manager' ? '管理者' : p.myRole === 'editor' ? '编辑' : p.myRole === 'reviewer' ? '审阅' : '只读'}
                  </span>
                </Tooltip>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {/* ---------- 表格视图（通用表格组件） ---------- */}
      {view === 'table' && list.length > 0 && (
        <DataTable<ProjectSummary>
          data={list}
          rowKey="id"
          emptyText="暂无项目"
          onRow={(r) => ({ onClick: () => nav(`/p/${r.id}`), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: '项目', dataIndex: 'name', width: 220,
              render: (v: string, p: ProjectSummary) => (
                <span>
                  <FolderOpenOutlined style={{ marginRight: 8, color: '#4f7cff' }} />
                  {v}
                  {p.archivedAt && <Tag style={{ marginLeft: 8 }}>已归档</Tag>}
                </span>
              ),
            },
            { title: '描述', dataIndex: 'description', ellipsis: true, render: (v: string) => v || '—' },
            {
              title: '类别', dataIndex: 'kind', width: 90,
              render: (v: ProjectKind) => (
                <Tag color={v === 'external' ? 'orange' : 'blue'} style={{ margin: 0 }}>
                  {KIND_LABEL[v ?? 'self']}
                </Tag>
              ),
            },
            { title: '成员', dataIndex: 'memberCount', width: 80, render: (v: number) => <span><TeamOutlined style={{ marginRight: 6 }} />{v}</span> },
            {
              title: '我的角色', dataIndex: 'myRole', width: 100,
              render: (r: string) => <Tag color={{ admin: 'volcano', manager: 'gold', editor: 'blue', reviewer: 'cyan', viewer: 'default' }[r] ?? 'default'}>
                {r === 'admin' ? '管理员' : r === 'manager' ? '管理者' : r === 'editor' ? '编辑' : r === 'reviewer' ? '审阅' : '只读'}
              </Tag>,
            },
            { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleDateString('zh-CN') },
            ...(user.isAdmin
              ? [{
                  title: '操作', width: 130,
                  render: (_: any, p: ProjectSummary) => (
                    <span onClick={(e) => e.stopPropagation()}>
                      <a onClick={() => openEdit(p)} style={{ marginRight: 12 }}><EditOutlined /></a>
                      <Popconfirm title="删除项目？" description="将同时删除全部素材文件与批注，不可恢复"
                        onConfirm={() => remove.mutate(p.id)}>
                        <a style={{ color: '#ff4d4f' }}><DeleteOutlined /></a>
                      </Popconfirm>
                    </span>
                  ),
                }]
              : []),
          ] as any}
        />
      )}

      <Modal
        title={editing ? '编辑项目' : '新建项目'}
        open={open}
        onCancel={() => { setOpen(false); setEditing(null); }}
        onOk={() => form.submit()}
        confirmLoading={create.isPending || update.isPending}
        okText={editing ? '保存' : '创建'}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            if (editing) update.mutate({ id: editing.id, name: v.name, kind: v.kind, description: v.description });
            else create.mutate(v);
          }}
        >
          <Form.Item name="name" label="项目名" rules={[{ required: true }]}>
            <Input placeholder="例如：品牌片 Q4" />
          </Form.Item>
          <Form.Item name="kind" label="类别" initialValue="self">
            <Radio.Group optionType="button" buttonStyle="solid">
              <Radio.Button value="self">自制</Radio.Button>
              <Radio.Button value="external">外部</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
