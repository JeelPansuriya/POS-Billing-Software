import { useEffect, useState } from 'react';
import { useApp } from '../store';

export default function SettingsPage() {
  const user = useApp((s) => s.user)!;
  const [prices, setPrices] = useState<{ lunch: number; dinner: number }>({ lunch: 0, dinner: 0 });
  const [restaurantName, setRestaurantName] = useState('');
  const [printerName, setPrinterName] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [syncStatus, setSyncStatus] = useState('');

  const load = async () => {
    const p = await window.api.prices.get();
    setPrices(p);
    setRestaurantName((await window.api.settings.get('restaurant_name')) ?? '');
    setPrinterName((await window.api.settings.get('printer_name')) ?? '');
    setSupabaseUrl((await window.api.settings.get('supabase_url')) ?? '');
    setSupabaseKey((await window.api.settings.get('supabase_anon_key')) ?? '');
  };

  useEffect(() => {
    load();
  }, []);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2500);
  };

  const saveAll = async () => {
    await window.api.prices.set('lunch', Number(prices.lunch) || 0);
    await window.api.prices.set('dinner', Number(prices.dinner) || 0);
    await window.api.settings.set('restaurant_name', restaurantName);
    await window.api.settings.set('printer_name', printerName);
    await window.api.settings.set('supabase_url', supabaseUrl);
    await window.api.settings.set('supabase_anon_key', supabaseKey);
    flash('Settings saved.');
  };

  const changePwd = async () => {
    if (!oldPwd || !newPwd) return flash('Enter both passwords.');
    const res = await window.api.auth.changePassword(user.id, oldPwd, newPwd);
    if (res.ok) {
      flash('Password updated.');
      setOldPwd('');
      setNewPwd('');
    } else {
      flash(res.error ?? 'Failed.');
    }
  };

  const syncNow = async () => {
    setSyncStatus('Syncing…');
    const res = await window.api.sync.now();
    if (res.ok) setSyncStatus(`Synced ${res.synced} bill(s).`);
    else setSyncStatus(`Sync failed: ${res.reason}`);
    setTimeout(() => setSyncStatus(''), 4000);
  };

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Settings</h1>

      <div className="grid grid-cols-2 gap-4 max-w-5xl">
        <Section title="Restaurant">
          <Field label="Restaurant Name">
            <input
              value={restaurantName}
              onChange={(e) => setRestaurantName(e.target.value)}
              className="input"
            />
          </Field>
        </Section>

        <Section title="Pricing (Thali per plate)">
          <Field label="Lunch Price (₹)">
            <input
              type="number"
              value={prices.lunch}
              onChange={(e) => setPrices({ ...prices, lunch: Number(e.target.value) })}
              className="input"
            />
          </Field>
          <Field label="Dinner Price (₹)">
            <input
              type="number"
              value={prices.dinner}
              onChange={(e) => setPrices({ ...prices, dinner: Number(e.target.value) })}
              className="input"
            />
          </Field>
        </Section>

        <Section title="Thermal Printer (80mm)">
          <Field label="Windows Printer Name">
            <input
              value={printerName}
              onChange={(e) => setPrinterName(e.target.value)}
              placeholder='e.g. "Hewlett BillQuick Lite H80i"'
              className="input"
            />
          </Field>
          <p className="text-xs text-gray-500 mt-1">
            Leave blank to use the system default printer. Open Windows → Settings → Bluetooth &
            devices → Printers and copy the exact printer name.
          </p>
        </Section>

        <Section title="Supabase Cloud Backup">
          <Field label="Supabase URL">
            <input
              value={supabaseUrl}
              onChange={(e) => setSupabaseUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              className="input"
            />
          </Field>
          <Field label="Supabase Anon Key">
            <input
              value={supabaseKey}
              onChange={(e) => setSupabaseKey(e.target.value)}
              placeholder="eyJhbGciOi..."
              className="input"
            />
          </Field>
          <button
            onClick={syncNow}
            className="mt-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            Sync Now
          </button>
          {syncStatus && <p className="text-sm text-gray-700 mt-2">{syncStatus}</p>}
          <p className="text-xs text-gray-500 mt-2">
            Run the SQL in <code>supabase/schema.sql</code> in your Supabase project, then paste
            the URL and anon key here. After saving, restart the app.
          </p>
        </Section>

        <Section title={`Change Password (${user.username})`}>
          <Field label="Current Password">
            <input
              type="password"
              value={oldPwd}
              onChange={(e) => setOldPwd(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="New Password">
            <input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              className="input"
            />
          </Field>
          <button
            onClick={changePwd}
            className="mt-2 px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-800 text-white text-sm font-medium"
          >
            Change Password
          </button>
        </Section>
      </div>

      <div className="mt-6 max-w-5xl flex items-center gap-4">
        <button
          onClick={saveAll}
          className="px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold"
        >
          Save Settings
        </button>
        {msg && <span className="text-sm text-green-700">{msg}</span>}
      </div>

      <style>{`
        .input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          background: white;
        }
        .input:focus {
          border-color: #ea580c;
          box-shadow: 0 0 0 2px rgba(234, 88, 12, 0.15);
        }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h3 className="font-semibold text-gray-800 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
