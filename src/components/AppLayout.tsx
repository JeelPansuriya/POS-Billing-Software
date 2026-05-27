import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../store';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, mealType, setMealType, logout } = useApp();
  const loc = useLocation();
  const [pending, setPending] = useState<number>(0);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncFlash, setSyncFlash] = useState<string | null>(null);

  useEffect(() => {
    const tick = async () => {
      setPending(await window.api.sync.pendingCount());
      setLastSyncAt(await window.api.settings.get('last_sync_at'));
    };
    tick();
    const id = setInterval(tick, 5000);
    const on = () => {
      setOnline(true);
      window.api.sync.now();
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const triggerSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncFlash(null);
    try {
      const res = await window.api.sync.now();
      setLastSyncAt(await window.api.settings.get('last_sync_at'));
      setPending(await window.api.sync.pendingCount());
      if (res.ok) {
        setSyncFlash(
          res.synced > 0 ? `Synced ${res.synced}` : 'Up to date'
        );
      } else {
        setSyncFlash(`Failed: ${res.reason ?? 'unknown'}`);
      }
      setTimeout(() => setSyncFlash(null), 2500);
    } finally {
      setSyncing(false);
    }
  };

  const syncLabel = (() => {
    if (!lastSyncAt) return 'never';
    const diffMin = Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  })();
  // Warn if it's been more than 6 hours since the last successful upload.
  const syncOverdue = lastSyncAt
    ? Date.now() - new Date(lastSyncAt).getTime() > 6 * 60 * 60 * 1000
    : true;

  const tab = (path: string, label: string) => {
    const active = loc.pathname === path;
    return (
      <Link
        to={path}
        className={`px-4 py-2 rounded-md text-sm font-medium transition ${
          active ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-200'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 bg-white border-b shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-brand-700">Restaurant POS</span>
          <nav className="flex gap-1 ml-4">
            {tab('/', 'Billing')}
            {(user?.role === 'manager' || user?.role === 'owner') && tab('/tools', 'Tools')}
            {user?.role === 'owner' && tab('/analytics', 'Analytics')}
            {user?.role === 'owner' && tab('/settings', 'Settings')}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-gray-100 rounded-md p-1">
            <button
              onClick={() => setMealType('lunch')}
              className={`px-4 py-1 rounded text-sm font-semibold transition ${
                mealType === 'lunch' ? 'bg-yellow-400 text-yellow-900' : 'text-gray-600'
              }`}
            >
              ☀ Lunch
            </button>
            <button
              onClick={() => setMealType('dinner')}
              className={`px-4 py-1 rounded text-sm font-semibold transition ${
                mealType === 'dinner' ? 'bg-indigo-500 text-white' : 'text-gray-600'
              }`}
            >
              ☾ Dinner
            </button>
          </div>

          <button
            type="button"
            onClick={triggerSync}
            disabled={syncing || !online}
            className={`flex items-center gap-2 text-xs px-2 py-1 rounded transition ${
              !online
                ? 'bg-amber-100 text-amber-800 cursor-not-allowed'
                : syncOverdue
                ? 'bg-red-100 text-red-800 hover:bg-red-200'
                : 'bg-green-100 text-green-800 hover:bg-green-200'
            } ${syncing ? 'opacity-70 cursor-wait' : ''}`}
            title={
              online
                ? `Last cloud backup: ${syncLabel}${pending > 0 ? ` · ${pending} unsynced` : ''}\nClick to sync now.`
                : 'Offline — bills are saved locally'
            }
          >
            <span
              className={`w-2 h-2 rounded-full ${
                !online
                  ? 'bg-amber-500'
                  : syncOverdue
                  ? 'bg-red-500'
                  : 'bg-green-500'
              } ${syncing ? 'animate-pulse' : ''}`}
            />
            {!online
              ? 'Offline'
              : syncing
              ? 'Syncing…'
              : syncFlash
              ? syncFlash
              : `Synced ${syncLabel}`}
            {!syncing && !syncFlash && pending > 0 && (
              <span className="ml-1 font-bold">({pending})</span>
            )}
          </button>

          <span className="text-sm text-gray-600">
            {user?.username} <span className="text-xs uppercase text-gray-400">({user?.role})</span>
          </span>
          <button
            onClick={logout}
            className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-100"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
