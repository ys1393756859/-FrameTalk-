import { Outlet, useLocation, useNavigate } from 'react-router';
import { Menu } from 'antd';
import {
  DashboardOutlined, TeamOutlined, DatabaseOutlined, CodeSandboxOutlined,
  AuditOutlined, SettingOutlined,
} from '@ant-design/icons';

const ITEMS = [
  { key: '/admin', icon: <DashboardOutlined />, label: '项目总览' },
  { key: '/admin/users', icon: <TeamOutlined />, label: '用户管理' },
  { key: '/admin/storage', icon: <DatabaseOutlined />, label: '存储监控' },
  { key: '/admin/transcodes', icon: <CodeSandboxOutlined />, label: '转码任务' },
  { key: '/admin/audit', icon: <AuditOutlined />, label: '审计日志' },
  { key: '/admin/settings', icon: <SettingOutlined />, label: '系统设置' },
];

/**
 * 管理后台布局：纯 div 侧栏 + 内容区。
 * 不用 antd Layout/Sider/Content —— 外层 AppLayout 已有 antd Layout，嵌套会互相干扰样式。
 * 新页面 = ITEMS 加一项 + App.tsx 加一条路由。
 * 菜单不用 NavLink 内嵌小链接（点击热区只有文字那么大，点图标/边缘无反应），
 * 统一由 Menu onClick 导航，整项可点；selectedKeys 必须来自 useLocation（订阅路由变化），
 * 读全局 location.pathname 不会触发重渲染，高亮会停留在挂载时的旧值。
 */
export default function AdminLayout() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside
        className="admin-aside"
        style={{
          width: 190,
          flexShrink: 0,
          background: '#17171a',
          borderRight: '1px solid #262626',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
      >
        <div style={{ color: '#8c8c8c', padding: '14px 20px', fontSize: 12, letterSpacing: 2 }}>管理后台</div>
        <Menu
          mode="inline"
          selectedKeys={[pathname]}
          items={ITEMS}
          onClick={({ key }) => nav(key)}
          style={{ background: 'transparent', borderRight: 0, minWidth: 188 }}
        />
      </aside>
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#141414' }}>
        <Outlet />
      </main>
    </div>
  );
}
