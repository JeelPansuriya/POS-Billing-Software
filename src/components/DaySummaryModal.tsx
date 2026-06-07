import { useEffect, useState } from 'react';

type MealBreakdown = {
  bills: number;
  plates: number;
  plateRevenue: number;
  revenue: number;
  extras: Array<{ name: string; qty: number; revenue: number }>;
};

type Summary = {
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
  lunch: MealBreakdown;
  dinner: MealBreakdown;
  extras: Array<{ name: string; qty: number; revenue: number }>;
};

export default function DaySummaryModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Summary | null>(null);
  const [printing, setPrinting] = useState(false);
  const [result, setResult] = useState<{
    printed: boolean;
    printError?: string;
    sync: { ok: boolean; synced: number; failed: number; reason?: string };
  } | null>(null);

  useEffect(() => {
    window.api.day.summary().then(setData);
  }, []);

  const closeDay = async () => {
    setPrinting(true);
    setResult(null);
    try {
      const res = await window.api.day.print();
      setResult(res);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Day Summary</h2>
            <p className="text-xs text-gray-500">{data?.day ?? '—'}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-gray-100 text-gray-500 text-lg"
          >
            ×
          </button>
        </div>

        {!data ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : (
          <div className="p-6 space-y-4">
            <Stat label="Tokens issued" value={`${data.totalBills}`} />
            <Stat
              label="Token range"
              value={
                data.firstToken && data.lastToken
                  ? `#${data.firstToken} – #${data.lastToken}`
                  : '—'
              }
            />
            <Stat label="Plates sold" value={`${data.totalPlates}`} />

            <MealSection label="Lunch" emoji="☀" m={data.lunch} accent="yellow" />
            <MealSection label="Dinner" emoji="☾" m={data.dinner} accent="indigo" />

            <div className="border-t pt-4">
              <Row
                label="💵 Cash"
                value={`₹${data.cashRevenue.toLocaleString()}`}
                accent="green"
              />
              <Row
                label="📱 UPI"
                value={`₹${data.upiRevenue.toLocaleString()}`}
                accent="blue"
              />
            </div>

            <div className="border-t pt-4">
              <div className="flex items-center justify-between p-3 rounded-xl bg-brand-50 border border-brand-200">
                <span className="text-sm font-semibold text-brand-700">TOTAL REVENUE</span>
                <span className="text-2xl font-bold text-brand-700 tabular-nums">
                  ₹{data.totalRevenue.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
          {!result ? (
            <p className="text-xs text-gray-500 mb-3">
              "Close Day" prints a summary slip to the thermal printer and pushes today's bills to
              Supabase backup.
            </p>
          ) : (
            <div className="mb-3 space-y-1">
              {result.printed ? (
                <p className="text-sm text-green-700">✓ Summary slip printed.</p>
              ) : (
                <p className="text-sm text-red-700">
                  ✗ Print failed: {result.printError ?? 'unknown error'}
                </p>
              )}
              {result.sync.ok ? (
                <p className="text-sm text-green-700">
                  ✓ Cloud backup: synced {result.sync.synced} bill
                  {result.sync.synced === 1 ? '' : 's'}.
                </p>
              ) : (
                <p className="text-sm text-amber-700">
                  ⚠ Cloud backup didn't run: {result.sync.reason ?? 'unknown'}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-white text-sm"
            >
              Close
            </button>
            <button
              onClick={closeDay}
              disabled={!data || printing}
              className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm"
            >
              {printing ? 'Working…' : 'Close Day (print + sync)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="text-lg font-bold text-gray-800 tabular-nums">{value}</span>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'blue';
}) {
  const color =
    accent === 'green' ? 'text-green-700' : accent === 'blue' ? 'text-blue-700' : 'text-gray-800';
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-base font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function MealSection({
  label,
  emoji,
  m,
  accent,
}: {
  label: string;
  emoji: string;
  m: MealBreakdown;
  accent: 'yellow' | 'indigo';
}) {
  // Empty meals stay invisible — keeps the modal compact for restaurants that
  // run a single sitting on some days.
  if (m.bills === 0) return null;
  const headerBg =
    accent === 'yellow' ? 'bg-yellow-100 text-yellow-900' : 'bg-indigo-100 text-indigo-900';
  return (
    <div className="border-t pt-3">
      <div
        className={`flex items-center justify-between px-2 py-1 rounded-md font-semibold text-sm ${headerBg}`}
      >
        <span>
          {emoji} {label}
        </span>
        <span className="tabular-nums">₹{m.revenue.toLocaleString()}</span>
      </div>
      <div className="mt-2 px-2">
        {m.extras.map((x) => (
          <div key={x.name} className="flex items-baseline gap-2 py-1 text-sm">
            <span className="font-medium flex-1">{x.name}</span>
            <span className="text-gray-500 tabular-nums">{x.qty}</span>
            <span className="font-semibold tabular-nums w-20 text-right">
              ₹{x.revenue.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
