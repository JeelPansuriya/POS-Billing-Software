import { useEffect, useState } from 'react';
import { useApp } from '../store';

export default function SettingsPage() {
  const user = useApp((s) => s.user)!;
  const [prices, setPrices] = useState<{ lunch: number; dinner: number }>({ lunch: 0, dinner: 0 });
  const [restaurantName, setRestaurantName] = useState('');
  const [printerName, setPrinterName] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [backupSchedule, setBackupSchedule] = useState('15:00,20:00,23:00');
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [msg, setMsg] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [exportDir, setExportDir] = useState('');
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState('');

  const load = async () => {
    const p = await window.api.prices.get();
    setPrices(p);
    setRestaurantName((await window.api.settings.get('restaurant_name')) ?? '');
    setPrinterName((await window.api.settings.get('printer_name')) ?? '');
    setSupabaseUrl((await window.api.settings.get('supabase_url')) ?? '');
    setSupabaseKey((await window.api.settings.get('supabase_anon_key')) ?? '');
    setBackupSchedule(
      (await window.api.settings.get('backup_schedule')) ?? '15:00,20:00,23:00'
    );
    setExportDir(await window.api.exportLocal.getDir());
    setLastExportAt(await window.api.settings.get('last_local_export_at'));
    setLastExportPath(await window.api.settings.get('last_local_export_path'));
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
    await window.api.settings.set('backup_schedule', backupSchedule.trim());
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

  const pickExportDir = async () => {
    const res = await window.api.exportLocal.pickDir();
    if (res.ok && res.path) {
      setExportDir(res.path);
      flash('Backup folder updated.');
    }
  };

  const exportNow = async () => {
    setExportStatus('Exporting…');
    const res = await window.api.exportLocal.run();
    if (res.ok) {
      setExportStatus(`Exported ${res.rows} bill(s) → ${res.path}`);
      setLastExportAt(new Date().toISOString());
      setLastExportPath(res.path ?? null);
    } else {
      setExportStatus(`Export failed: ${res.error}`);
    }
    setTimeout(() => setExportStatus(''), 5000);
  };

  const openExportFolder = async () => {
    await window.api.exportLocal.openFolder();
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
          <Field label="Backup Schedule (24h, comma-separated)">
            <input
              value={backupSchedule}
              onChange={(e) => setBackupSchedule(e.target.value)}
              placeholder="15:00,20:00,23:00"
              className="input"
            />
          </Field>
          <p className="text-xs text-gray-500 mt-1">
            Auto-syncs to Supabase at each listed time. Defaults: 3 PM (lunch close),
            8 PM (dinner peak), 11 PM (end of day). If the app was offline at that time,
            it catches up on the next launch.
          </p>
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

        <Section title="Daily Local Backup (CSV)">
          <Field label="Backup Folder">
            <div className="flex items-center gap-2">
              <input
                value={exportDir}
                readOnly
                className="input flex-1 bg-gray-50 text-xs"
                title={exportDir}
              />
              <button
                onClick={pickExportDir}
                className="px-3 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 text-sm font-medium whitespace-nowrap"
              >
                Change…
              </button>
            </div>
          </Field>
          <p className="text-xs text-gray-500 mt-1">
            A CSV of each day's bills is written here automatically once per day. Point this at a
            Dropbox / OneDrive folder for off-site safety.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={exportNow}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
            >
              Export Today Now
            </button>
            <button
              onClick={openExportFolder}
              className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 text-sm font-medium"
            >
              Open Folder
            </button>
          </div>
          {exportStatus && <p className="text-sm text-gray-700 mt-2 break-all">{exportStatus}</p>}
          {lastExportAt && (
            <p className="text-xs text-gray-500 mt-2 break-all">
              Last export: {new Date(lastExportAt).toLocaleString()}
              {lastExportPath ? ` — ${lastExportPath}` : ''}
            </p>
          )}
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
