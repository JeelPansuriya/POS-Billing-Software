import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './store';
import LoginPage from './pages/LoginPage';
import BillingPage from './pages/BillingPage';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';
import AppLayout from './components/AppLayout';

export default function App() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);

  // Dev-only: auto-login as owner once on initial mount so we don't sign in every reload.
  // Stripped from production builds because import.meta.env.DEV is statically false.
  // Manual logout still works — this only runs once.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (async () => {
      const res = await window.api.auth.login('owner', 'owner123');
      if (res.ok) setUser(res.user);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user) return <LoginPage />;

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<BillingPage />} />
        <Route
          path="/analytics"
          element={user.role === 'owner' ? <AnalyticsPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/settings"
          element={user.role === 'owner' ? <SettingsPage /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}
