import { useEffect, useState } from 'react';

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" with no Z, and
// JS's Date() then treats that as local — wrong by the local TZ offset.
// Normalize to ISO with explicit Z so toLocale*() returns the correct hour.
function parseDbDate(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

type AuditRow = {
  id: string;
  at: string;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: string | null;
};

type CashState = {
  day: string;
  systemCash: number;
  counted: {
    countedCash: number;
    variance: number;
    note: string | null;
    recordedAt: string;
    recordedBy: string | null;
  } | null;
};

type UpdaterStatus = {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version: string;
  newVersion?: string;
  progressPct?: number;
  error?: string;
  checkedAt?: string;
};

type RestoreResult =
  | { ok: false; error?: string; canceled?: boolean }
  | { ok: true; preview: true; parsed: number; toInsert: number; skipped: number }
  | { ok: true; preview: false; inserted: number; skipped: number };

export default function ToolsPage() {
  const [flash, setFlash] = useState<string>('');
  const showFlash = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(''), 2500);
  };

  // Printer test
  const [printerTesting, setPrinterTesting] = useState(false);
  const runPrinterTest = async () => {
    setPrinterTesting(true);
    try {
      const r = await window.api.printer.test();
      showFlash(r.ok ? '✓ Test page sent to printer' : `Printer test failed: ${r.error ?? 'unknown'}`);
    } finally {
      setPrinterTesting(false);
    }
  };

  // Token PDF preview — render the slip layout to PDF without a printer.
  const [previewing, setPreviewing] = useState(false);
  const runTokenPreview = async () => {
    setPreviewing(true);
    try {
      const r = await window.api.printer.previewPdf();
      showFlash(r.ok ? `✓ Opened ${r.path}` : `Preview failed: ${r.error}`);
    } finally {
      setPreviewing(false);
    }
  };

  // Day summary by date — pick any past day, view stats, optionally reprint.
  type DaySummary = {
    day: string;
    totalBills: number;
    totalPlates: number;
    totalRevenue: number;
    firstToken: number | null;
    lastToken: number | null;
    lunchPlates: number;
    lunchRevenue: number;
    dinnerPlates: number;
    dinnerRevenue: number;
    cashRevenue: number;
    upiRevenue: number;
  };
  const todayIso = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();
  const [summaryDate, setSummaryDate] = useState<string>(todayIso);
  const [summaryData, setSummaryData] = useState<DaySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryPrinting, setSummaryPrinting] = useState(false);
  const loadSummary = async (day: string) => {
    setSummaryLoading(true);
    try {
      setSummaryData(await window.api.day.summary(day));
    } finally {
      setSummaryLoading(false);
    }
  };
  const printSummary = async () => {
    setSummaryPrinting(true);
    try {
      const r = await window.api.day.print(summaryDate);
      showFlash(
        r.printed ? '✓ Day summary printed' : `Print failed: ${r.printError ?? 'unknown'}`
      );
    } finally {
      setSummaryPrinting(false);
    }
  };
  useEffect(() => {
    loadSummary(summaryDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DB integrity
  const [integrity, setIntegrity] = useState<{ ok: boolean; messages: string[] } | null>(null);
  const [integrityRunning, setIntegrityRunning] = useState(false);
  const runIntegrity = async () => {
    setIntegrityRunning(true);
    try {
      setIntegrity(await window.api.db.integrityCheck());
    } finally {
      setIntegrityRunning(false);
    }
  };

  // Cash reconciliation
  const [cash, setCash] = useState<CashState | null>(null);
  const [countedInput, setCountedInput] = useState<string>('');
  const [cashNote, setCashNote] = useState<string>('');
  const [cashSaving, setCashSaving] = useState(false);
  const loadCash = async () => {
    const c = await window.api.cash.get();
    setCash(c);
    if (c.counted) {
      setCountedInput(String(c.counted.countedCash));
      setCashNote(c.counted.note ?? '');
    }
  };
  const saveCash = async () => {
    const n = Number(countedInput);
    if (!Number.isFinite(n) || n < 0) {
      showFlash('Enter a valid counted-cash amount');
      return;
    }
    setCashSaving(true);
    try {
      const r = await window.api.cash.set({ countedCash: Math.round(n), note: cashNote });
      if (r.ok) {
        showFlash(`✓ Saved · variance ₹${r.variance}`);
        await loadCash();
      } else {
        showFlash('Failed to save cash count');
      }
    } finally {
      setCashSaving(false);
    }
  };

  // Restore from CSV
  const [restorePreview, setRestorePreview] = useState<RestoreResult | null>(null);
  const [restoring, setRestoring] = useState(false);
  const previewRestore = async () => {
    setRestoring(true);
    try {
      const r = await window.api.restore.fromCsv({ commit: false });
      setRestorePreview(r);
      if (!r.ok && r.canceled) showFlash('Cancelled');
    } finally {
      setRestoring(false);
    }
  };
  const commitRestore = async () => {
    if (!confirm('Commit the restore? Rows already present will be skipped, the rest inserted as pending sync.'))
      return;
    setRestoring(true);
    try {
      const r = await window.api.restore.fromCsv({ commit: true });
      setRestorePreview(r);
      if (r.ok && r.preview === false) {
        showFlash(`✓ Inserted ${r.inserted}, skipped ${r.skipped}`);
      }
    } finally {
      setRestoring(false);
    }
  };

  // App updates
  const [upd, setUpd] = useState<UpdaterStatus | null>(null);
  const [updChecking, setUpdChecking] = useState(false);
  useEffect(() => {
    window.api.updates.status().then(setUpd);
    const off = window.api.updates.onEvent(setUpd);
    return off;
  }, []);
  const checkUpdates = async () => {
    setUpdChecking(true);
    try {
      const r = await window.api.updates.check();
      if (!r.ok) showFlash(r.error ?? 'Update check failed');
    } finally {
      setUpdChecking(false);
    }
  };

  // Audit log
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditFilter, setAuditFilter] = useState<string>('');
  const loadAudit = async () => {
    const list = await window.api.audit.list({
      limit: 100,
      action: auditFilter || undefined,
    });
    setAudit(list);
  };

  useEffect(() => {
    loadCash();
    loadAudit();
  }, []);

  return (
    <div className="h-full overflow-auto p-6 bg-gray-50">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">Tools</h1>
          {flash && (
            <div className="px-3 py-1.5 rounded bg-brand-100 text-brand-800 text-sm">{flash}</div>
          )}
        </div>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">App updates</h2>
          <p className="text-sm text-gray-500 mb-3">
            Current version: <span className="font-mono">{upd?.version ?? '—'}</span>
            {upd?.newVersion && upd.newVersion !== upd.version && (
              <>
                {' · new: '}
                <span className="font-mono font-semibold text-brand-700">{upd.newVersion}</span>
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={updChecking || upd?.phase === 'checking' || upd?.phase === 'downloading'}
              onClick={checkUpdates}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {upd?.phase === 'checking'
                ? 'Checking…'
                : upd?.phase === 'downloading'
                ? `Downloading ${upd.progressPct ?? 0}%`
                : 'Check for updates'}
            </button>
            {upd?.phase === 'downloaded' && (
              <button
                onClick={() => window.api.updates.install()}
                className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-semibold"
              >
                Restart &amp; install
              </button>
            )}
          </div>
          {upd && (
            <div className="mt-3 text-sm">
              {upd.phase === 'not-available' && (
                <div className="p-3 rounded bg-green-50 border border-green-200 text-green-800">
                  ✓ You're on the latest version.
                </div>
              )}
              {upd.phase === 'downloaded' && (
                <div className="p-3 rounded bg-blue-50 border border-blue-200 text-blue-800">
                  Update {upd.newVersion} downloaded. Click Restart &amp; install to apply now —
                  your data is preserved.
                </div>
              )}
              {upd.phase === 'error' && upd.error && (
                <div className="p-3 rounded bg-red-50 border border-red-300 text-red-800">
                  {upd.error}
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">
            Bills, settings, and audit log are stored separately and survive every update.
          </p>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Printer test</h2>
          <p className="text-sm text-gray-500 mb-3">
            Print a sample slip on the configured 80mm thermal printer. Use this after changing
            cables or driver settings.
          </p>
          <div className="flex gap-2">
            <button
              disabled={printerTesting}
              onClick={runPrinterTest}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {printerTesting ? 'Printing…' : 'Print test page'}
            </button>
            <button
              disabled={previewing}
              onClick={runTokenPreview}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-semibold disabled:opacity-50"
            >
              {previewing ? 'Generating…' : 'Preview token (PDF)'}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            "Preview token (PDF)" renders a sample slip to PDF and opens it — no printer needed.
          </p>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Day summary by date</h2>
          <p className="text-sm text-gray-500 mb-3">
            Pick any past date to see that day's totals. The numbers exclude voided bills and
            mirror what would print if you hit "Print this day" on the slip below.
          </p>
          <div className="flex items-center gap-2 mb-3">
            <input
              type="date"
              value={summaryDate}
              max={todayIso}
              onChange={(e) => {
                setSummaryDate(e.target.value);
                if (e.target.value) loadSummary(e.target.value);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <button
              onClick={() => loadSummary(summaryDate)}
              disabled={summaryLoading}
              className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-100 text-sm font-medium disabled:opacity-50"
            >
              {summaryLoading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              onClick={printSummary}
              disabled={summaryPrinting || !summaryData || summaryData.totalBills === 0}
              className="ml-auto px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {summaryPrinting ? 'Printing…' : 'Print this day'}
            </button>
          </div>
          {summaryData && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm bg-gray-50 rounded-lg border border-gray-200 p-4">
              <SummaryRow label="Tokens issued" value={`${summaryData.totalBills}`} />
              <SummaryRow
                label="Token range"
                value={
                  summaryData.firstToken && summaryData.lastToken
                    ? `#${summaryData.firstToken} – #${summaryData.lastToken}`
                    : '—'
                }
              />
              <SummaryRow label="Plates sold" value={`${summaryData.totalPlates}`} />
              <SummaryRow
                label="Total revenue"
                value={`₹${summaryData.totalRevenue.toLocaleString()}`}
                accent
              />
              <SummaryRow label="Lunch plates" value={`${summaryData.lunchPlates}`} />
              <SummaryRow
                label="Lunch revenue"
                value={`₹${summaryData.lunchRevenue.toLocaleString()}`}
              />
              <SummaryRow label="Dinner plates" value={`${summaryData.dinnerPlates}`} />
              <SummaryRow
                label="Dinner revenue"
                value={`₹${summaryData.dinnerRevenue.toLocaleString()}`}
              />
              <SummaryRow label="Cash" value={`₹${summaryData.cashRevenue.toLocaleString()}`} />
              <SummaryRow label="UPI" value={`₹${summaryData.upiRevenue.toLocaleString()}`} />
            </div>
          )}
          {summaryData && summaryData.totalBills === 0 && (
            <p className="text-xs text-gray-400 mt-2">No bills on this day.</p>
          )}
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Database integrity</h2>
          <p className="text-sm text-gray-500 mb-3">
            Runs SQLite's <code>PRAGMA integrity_check</code>. If it ever reports anything other
            than "ok", restore from your latest backup.
          </p>
          <button
            disabled={integrityRunning}
            onClick={runIntegrity}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-semibold disabled:opacity-50"
          >
            {integrityRunning ? 'Checking…' : 'Run integrity check'}
          </button>
          {integrity && (
            <div
              className={`mt-3 p-3 rounded text-sm ${
                integrity.ok
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-300 text-red-800'
              }`}
            >
              {integrity.ok ? '✓ Database OK' : '⚠ Issues:'}
              {!integrity.ok && (
                <ul className="mt-1 list-disc list-inside text-xs">
                  {integrity.messages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Cash reconciliation</h2>
          {!cash ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="bg-gray-50 rounded p-3">
                  <div className="text-xs uppercase text-gray-500">Day</div>
                  <div className="font-semibold tabular-nums">{cash.day}</div>
                </div>
                <div className="bg-green-50 rounded p-3">
                  <div className="text-xs uppercase text-green-700">System cash</div>
                  <div className="font-semibold tabular-nums text-green-800">
                    ₹{cash.systemCash.toLocaleString()}
                  </div>
                </div>
                <div className="bg-blue-50 rounded p-3">
                  <div className="text-xs uppercase text-blue-700">Counted</div>
                  <div className="font-semibold tabular-nums text-blue-800">
                    {cash.counted ? `₹${cash.counted.countedCash.toLocaleString()}` : '—'}
                  </div>
                </div>
              </div>

              {cash.counted && (
                <div
                  className={`p-3 rounded text-sm ${
                    cash.counted.variance === 0
                      ? 'bg-green-50 border border-green-200 text-green-800'
                      : 'bg-amber-50 border border-amber-300 text-amber-800'
                  }`}
                >
                  Variance: <span className="font-bold">₹{cash.counted.variance}</span>
                  {cash.counted.note && <span> · {cash.counted.note}</span>}
                  <span className="ml-2 text-xs text-gray-500">
                    by {cash.counted.recordedBy ?? '—'} ·{' '}
                    {new Date(parseDbDate(cash.counted.recordedAt)).toLocaleTimeString()}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Counted ₹"
                  value={countedInput}
                  onChange={(e) => setCountedInput(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded"
                />
                <input
                  type="text"
                  placeholder="Note (optional)"
                  value={cashNote}
                  onChange={(e) => setCashNote(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded"
                />
              </div>
              <button
                disabled={cashSaving}
                onClick={saveCash}
                className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
              >
                {cashSaving ? 'Saving…' : cash.counted ? 'Update count' : 'Save count'}
              </button>
            </div>
          )}
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-800 mb-3">Restore from CSV</h2>
          <p className="text-sm text-gray-500 mb-3">
            Re-imports bills from a previously exported CSV. Existing rows (matched by id) are
            skipped — safe to re-run. Restored rows queue for sync.
          </p>
          <div className="flex gap-2">
            <button
              disabled={restoring}
              onClick={previewRestore}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-semibold disabled:opacity-50"
            >
              {restoring ? 'Working…' : 'Pick file & preview'}
            </button>
            {restorePreview &&
              restorePreview.ok &&
              restorePreview.preview === true &&
              restorePreview.toInsert > 0 && (
                <button
                  disabled={restoring}
                  onClick={commitRestore}
                  className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-50"
                >
                  Commit ({restorePreview.toInsert})
                </button>
              )}
          </div>
          {restorePreview && (
            <div className="mt-3 text-sm">
              {!restorePreview.ok && !restorePreview.canceled && (
                <div className="p-3 rounded bg-red-50 border border-red-300 text-red-800">
                  {restorePreview.error ?? 'Restore failed'}
                </div>
              )}
              {restorePreview.ok && restorePreview.preview === true && (
                <div className="p-3 rounded bg-blue-50 border border-blue-200 text-blue-800">
                  Parsed {restorePreview.parsed} rows · would insert {restorePreview.toInsert} ·
                  skip {restorePreview.skipped}
                </div>
              )}
              {restorePreview.ok && restorePreview.preview === false && (
                <div className="p-3 rounded bg-green-50 border border-green-200 text-green-800">
                  ✓ Inserted {restorePreview.inserted}, skipped {restorePreview.skipped}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-800">Audit log (last 100)</h2>
            <div className="flex gap-2">
              <select
                value={auditFilter}
                onChange={(e) => setAuditFilter(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-sm"
              >
                <option value="">All actions</option>
                <option value="login">login</option>
                <option value="login_failed">login_failed</option>
                <option value="logout">logout</option>
                <option value="password_change">password_change</option>
                <option value="price_change">price_change</option>
                <option value="setting_change">setting_change</option>
                <option value="void">void</option>
                <option value="restore">restore</option>
                <option value="integrity_check">integrity_check</option>
                <option value="cash_count">cash_count</option>
                <option value="printer_test">printer_test</option>
              </select>
              <button
                onClick={loadAudit}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-100 text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="border border-gray-200 rounded max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Entity</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {audit.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-gray-400 text-center">
                      No entries.
                    </td>
                  </tr>
                )}
                {audit.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">
                      {new Date(parseDbDate(r.at)).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.actor_username ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.action}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">
                      {r.entity_type ?? ''}
                      {r.entity_id ? ` #${r.entity_id.slice(0, 8)}` : ''}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 break-all max-w-md">
                      {r.details ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-gray-600">{label}</span>
      <span
        className={`tabular-nums ${
          accent ? 'font-bold text-brand-700' : 'font-semibold text-gray-800'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

