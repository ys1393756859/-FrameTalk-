import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { SessionUser } from '@frametalk/shared';
import LoginPage from './pages/LoginPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectPage from './pages/ProjectPage';
import ReviewPage from './pages/ReviewPage';
import AppLayout from './layout/AppLayout';
import AdminLayout from './pages/admin/layout';
import { AdminUsers, AdminOverview, AdminStorage, AdminTranscodes, AdminAudit } from './pages/admin';
import AdminSettings from './pages/admin/settings';

export default function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: SessionUser }>('/api/auth/me'),
    retry: false,
  });

  if (me.isPending) return null;

  const user = me.data?.user;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {user && user.mustChangePassword && (
        <>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="*" element={<Navigate to="/change-password" replace />} />
        </>
      )}
      {!user && (
        <>
          <Route path="/change-password" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<RequireLogin />} />
        </>
      )}
      {user && !user.mustChangePassword && (
        <>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<AppLayout user={user} onRefreshMe={() => me.refetch()} />}>
            <Route path="/" element={<ProjectsPage user={user} />} />
            <Route path="/p/:projectId" element={<ProjectPage user={user} />} />
            <Route path="/p/:projectId/a/:assetId" element={<ReviewPage user={user} />} />
            {user.isAdmin && (
              <Route element={<AdminLayout />}>
                <Route path="/admin" element={<AdminOverview />} />
                <Route path="/admin/users" element={<AdminUsers me={user} />} />
                <Route path="/admin/storage" element={<AdminStorage />} />
                <Route path="/admin/transcodes" element={<AdminTranscodes />} />
                <Route path="/admin/audit" element={<AdminAudit />} />
                <Route path="/admin/settings" element={<AdminSettings />} />
              </Route>
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </>
      )}
    </Routes>
  );
}

function RequireLogin() {
  const loc = useLocation();
  useEffect(() => {
    location.href = `/login?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`;
  }, [loc]);
  return null;
}
