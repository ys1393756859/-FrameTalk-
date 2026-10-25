import { useMemo, useState } from 'react';
import { Outlet, useNavigate, Navigate, useLocation } from 'react-router';
import { Layout, Menu, Badge, Dropdown, List, Button, Tag, Alert } from 'antd';
import { useQuery, useQueryClient, useMutation, keepPreviousData } from '@tanstack/react-query';
import { api } from '../api';
import { onEvent } from '../realtime';
import { useEffect } from 'react';
import { BellOutlined, LogoutOutlined, VideoCameraOutlined, SettingOutlined } from '@ant-design/icons';
import type { SessionUser, NotificationDto } from '@frametalk/shared';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
const fmtAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

export default function AppLayout({ user, onRefreshMe }: { user: SessionUser; onRefreshMe: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();
  // 剧集批注页（/p/:projectId/a/:assetId）全屏沉浸，不展示全局导航栏
  const isAssetPage = /^\/p\/[^/]+\/a\/[^/]+/.test(loc.pathname);

  // 通知面板：未读/已读两个 tab + 分页（服务端分页）
  const [notifTab, setNotifTab] = useState<'unread' | 'read'>('unread');
  const [notifPage, setNotifPage] = useState(1);
  const NOTIF_PAGE_SIZE = 10;
  const notif = useQuery({
    queryKey: ['notifications', notifTab, notifPage],
    queryFn: () => api<{ notifications: NotificationDto[]; unread: number; total: number }>(
      `/api/notifications?tab=${notifTab}&page=${notifPage}&pageSize=${NOTIF_PAGE_SIZE}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  // 已读/删除后 total 收缩，页码可能越界 → 回退到最后一页
  const notifTotal = notif.data?.total ?? 0;
  const notifMaxPage = Math.max(1, Math.ceil(notifTotal / NOTIF_PAGE_SIZE));
  useEffect(() => {
    if (notifPage > notifMaxPage) setNotifPage(notifMaxPage);
  }, [notifPage, notifMaxPage]);

  const storage = useQuery({
    queryKey: ['admin-storage-banner'],
    queryFn: () => api<{ lowSpace: boolean }>('/api/admin/storage'),
    enabled: user.isAdmin,
    refetchInterval: 60_000,
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (p: { all?: boolean; ids?: string[] }) => api('/api/notifications/read', { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const [notifOpen, setNotifOpen] = useState(false);
  const [hoverNotifId, setHoverNotifId] = useState<string | null>(null);

  // 单条通知 → 跳转对应剧集批注页并定位到该评论（?v= 版本 ?f= 帧 ?c= 评论）
  const openNotification = (n: NotificationDto) => {
    const p = n.payload as any;
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    setNotifOpen(false);
    if (p?.projectId && p?.assetId) {
      const qs = new URLSearchParams();
      if (p.versionId) qs.set('v', p.versionId);
      if (p.frameIn != null) qs.set('f', String(p.frameIn));
      if (p.commentId) qs.set('c', p.commentId);
      nav(`/p/${p.projectId}/a/${p.assetId}?${qs.toString()}`);
    } else if (p?.projectId) {
      nav(`/p/${p.projectId}`);
    }
  };

  useEffect(() => {
    const off = onEvent((evt) => {
      if (evt.type === 'notify') qc.invalidateQueries({ queryKey: ['notifications'] });
    });
    return off;
  }, [qc]);

  const items = useMemo(() => [
    { key: '/', icon: <VideoCameraOutlined />, label: '项目' },
    ...(user.isAdmin ? [
      { key: '/admin', icon: <SettingOutlined />, label: '管理后台' },
    ] : []),
  ], [user.isAdmin]);

  const notifList = notif.data?.notifications ?? [];

  return (
    <Layout style={{ height: '100%' }}>
      {!isAssetPage && user.isAdmin && storage.data?.lowSpace && (
        <Alert type="warning" banner showIcon message="服务器存储空间不足 15%，请扩容或归档旧项目原片" />
      )}
      {!isAssetPage && (
      <Layout.Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <Menu
          theme="dark" mode="horizontal" selectedKeys={[loc.pathname.startsWith('/admin') ? '/admin' : loc.pathname]} items={items}
          style={{ flex: 1, minWidth: 200, background: 'transparent' }}
          onClick={({ key }) => nav(key)}
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Dropdown
            trigger={['click']}
            open={notifOpen}
            onOpenChange={setNotifOpen}
            popupRender={() => (
                  <div style={{
                    width: 380, background: '#1f1f1f', borderRadius: 8, padding: '8px 4px 4px',
                    boxShadow: '0 6px 16px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08)',
                  }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px 0' }}>
                      <b>通知{notif.data?.unread ? <span style={{ color: '#4f7cff', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{notif.data.unread} 条未读</span> : null}</b>
                      <Button size="small" type="link" disabled={!notif.data?.unread}
                        onClick={() => markRead.mutate({ all: true })}>全部已读</Button>
                    </div>
                    <div style={{ display: 'flex', gap: 16, padding: '0 12px', marginTop: 2, borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                      {(['unread', 'read'] as const).map((k) => (
                        <div
                          key={k}
                          onClick={() => { setNotifTab(k); setNotifPage(1); }}
                          style={{
                            cursor: 'pointer', padding: '6px 2px', fontSize: 13,
                            color: notifTab === k ? '#4f7cff' : 'rgba(255,255,255,0.65)',
                            fontWeight: notifTab === k ? 600 : 400,
                            borderBottom: `2px solid ${notifTab === k ? '#4f7cff' : 'transparent'}`,
                          }}
                        >
                          {k === 'unread' ? `未读${notif.data?.unread ? ` (${notif.data.unread})` : ''}` : '已读'}
                        </div>
                      ))}
                    </div>
                    <div style={{ maxHeight: 340, overflow: 'auto' }}>
                    {notifList.length === 0 && <div style={{ padding: 16, color: '#888' }}>{notifTab === 'unread' ? '暂无未读通知' : '暂无已读通知'}</div>}
                    <List
                      size="small"
                      dataSource={notifList}
                      renderItem={(n: NotificationDto) => {
                        const p = n.payload as any;
                        const title = n.type === 'mention'
                          ? (p?.isReply ? `${p?.by ?? '有人'} 回复并@了你` : `${p?.by ?? '有人'} @了你`)
                          : n.type === 'comment'
                            ? (p?.isReply ? `${p?.by ?? '有人'} 回复了 ${p?.replyTo ?? ''} 的批注` : `${p?.by ?? '有人'} 发表了新批注`)
                            : n.type === 'status' ? '状态更新' : n.type;
                        return (
                          <List.Item
                            key={n.id}
                            onMouseEnter={() => setHoverNotifId(n.id)}
                            onMouseLeave={() => setHoverNotifId((v) => (v === n.id ? null : v))}
                            style={{
                              cursor: 'pointer', padding: '8px 10px', borderRadius: 6, margin: '0 4px',
                              transition: 'background 0.15s',
                              background: hoverNotifId === n.id
                                ? (n.readAt ? 'rgba(255,255,255,0.10)' : 'rgba(79,124,255,0.22)')
                                : (n.readAt ? undefined : 'rgba(79,124,255,0.10)'),
                              borderInlineStart: `3px solid ${n.readAt ? 'transparent' : '#4f7cff'}`,
                            }}
                            onClick={() => openNotification(n)}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {n.type === 'mention' && <Tag color="red" style={{ marginInlineEnd: 0, lineHeight: '16px', fontSize: 11 }}>@</Tag>}
                                <span style={{ fontWeight: n.readAt ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                                <span style={{ marginLeft: 'auto', color: '#777', fontSize: 11, flexShrink: 0 }}>{fmtAgo(n.createdAt)}</span>
                              </div>
                              <div style={{ color: '#888', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p?.assetName ? `《${p.assetName}》` : ''}{p?.frameIn != null ? ` 帧 ${p.frameIn}` : ''}
                                <span style={{ color: '#4f7cff', marginLeft: 8, fontSize: 11 }}>查看批注 →</span>
                              </div>
                            </div>
                          </List.Item>
                        );
                      }}
                    />
                    </div>
                    {notifTotal > NOTIF_PAGE_SIZE && (
                      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                        <Button size="small" type="text" disabled={notifPage <= 1} style={{ color: 'rgba(255,255,255,0.75)' }}
                          onClick={() => setNotifPage(notifPage - 1)}>上一页</Button>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>第 {notifPage} / {notifMaxPage} 页</span>
                        <Button size="small" type="text" disabled={notifPage >= notifMaxPage} style={{ color: 'rgba(255,255,255,0.75)' }}
                          onClick={() => setNotifPage(notifPage + 1)}>下一页</Button>
                      </div>
                    )}
                  </div>
            )}
          >
            <Badge count={notif.data?.unread ?? 0} size="small">
              <BellOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
            </Badge>
          </Dropdown>
          <span>{user.name}</span>
          <Button size="small" icon={<LogoutOutlined />} onClick={async () => {
            await api('/api/auth/logout', { method: 'POST' });
            location.href = '/login';
          }}>退出</Button>
        </div>
      </Layout.Header>
      )}
      <Layout.Content style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}

export function Forbidden() {
  return <div style={{ padding: 48 }}><Alert type="error" showIcon message="403 没有该项目权限" description="请向项目管理者申请加入。" /></div>;
}

export function NeedLogin() {
  return <Navigate to="/login" replace />;
}
