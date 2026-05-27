import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './store';
import LoginPage from './pages/LoginPage';
import BillingPage from './pages/BillingPage';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';
import ToolsPage from './pages/ToolsPage';
import AppLayout from './components/AppLayout';
import OnboardingWizard from './components/OnboardingWizard';

export default function App() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

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

  // First-launch gate: only the owner sees the wizard, and only when the
  // restaurant name or either price hasn't been configured yet. Managers
  // logging in first don't see it — they can't fix prices anyway.
  useEffect(() => {
    if (!user) {
      setOnboardingChecked(false);
      setNeedsOnboarding(false);
      return;
    }
    if (user.role !== 'owner') {
      setOnboardingChecked(true);
      setNeedsOnboarding(false);
      return;
    }
    (async () => {
      const name = await window.api.settings.get('restaurant_name');
      const prices = await window.api.prices.get();
      const incomplete = !name || !name.trim() || prices.lunch <= 0 || prices.dinner <= 0;
      setNeedsOnboarding(incomplete);
      setOnboardingChecked(true);
    })();
  }, [user]);

  if (!user) return <LoginPage />;

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<BillingPage />} />
        <Route
          path="/tools"
          element={
            user.role === 'manager' || user.role === 'owner' ? (
              <ToolsPage />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
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
      {onboardingChecked && needsOnboarding && (
        <OnboardingWizard onDone={() => setNeedsOnboarding(false)} />
      )}
    </AppLayout>
  );
}
