import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../store';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, mealType, setMealType, logout } = useApp();
  const loc = useLocation();
  const [pending, setPending] = useState<number>(0);
  const [online, setOnline] = useState<boolean>(navigator.onLine);

  useEffect(() => {
    const tick = async () => setPending(await window.api.sync.pendingCount());
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

          <div
            className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
              online ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
            }`}
            title={online ? 'Online' : 'Offline — bills are saved locally'}
          >
            <span
              className={`w-2 h-2 rounded-full ${online ? 'bg-green-500' : 'bg-amber-500'}`}
            />
            {online ? 'Online' : 'Offline'}
            {pending > 0 && (
              <span className="ml-1 font-bold">({pending} unsynced)</span>
            )}
          </div>

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
