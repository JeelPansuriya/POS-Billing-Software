import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

// Recharts is ~150 KB minified-gzipped. Lazy-loading the chart component
// keeps it out of the initial billing-page bundle so first paint stays fast;
// the chunk only fetches when an admin first opens Analytics.
const AnalyticsCharts = lazy(() => import('./AnalyticsCharts'));

type Range = 'today' | '7d' | '30d' | 'mtd' | 'all';

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" (space, no Z).
// Range bounds must be sent in the same shape so the WHERE created_at >= ?
// lexicographic comparison lines up — Date.toISOString() produces a "T"
// separator that sorts AFTER a space, which silently dropped late-night IST
// bills out of the "Today" window.
function toSqliteUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function rangeToDates(r: Range): { from: string; to: string; label: string } {
  const now = new Date();
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  switch (r) {
    case 'today':
      from.setDate(to.getDate() - 1);
      return { from: toSqliteUtc(from), to: toSqliteUtc(to), label: 'Today' };
    case '7d':
      from.setDate(to.getDate() - 7);
      return { from: toSqliteUtc(from), to: toSqliteUtc(to), label: 'Last 7 days' };
    case '30d':
      from.setDate(to.getDate() - 30);
      return { from: toSqliteUtc(from), to: toSqliteUtc(to), label: 'Last 30 days' };
    case 'mtd':
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      return { from: toSqliteUtc(from), to: toSqliteUtc(to), label: 'Month to date' };
    case 'all':
      return { from: '1970-01-01 00:00:00', to: toSqliteUtc(to), label: 'All time' };
  }
}

function previousPeriod(r: Range): { from: string; to: string } | null {
  if (r === 'all') return null;
  const cur = rangeToDates(r);
  // Parse the SQLite-format strings back to Dates by appending Z so JS reads them as UTC.
  const curFrom = new Date(cur.from.replace(' ', 'T') + 'Z');
  const curTo = new Date(cur.to.replace(' ', 'T') + 'Z');
  const span = curTo.getTime() - curFrom.getTime();
  const prevTo = curFrom;
  const prevFrom = new Date(curFrom.getTime() - span);
  return { from: toSqliteUtc(prevFrom), to: toSqliteUtc(prevTo) };
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>('today');
  const [data, setData] = useState<any>(null);
  const [prev, setPrev] = useState<{ bills: number; plates: number; revenue: number } | null>(
    null
  );
  const [hourly, setHourly] = useState<
    Array<{ hour: number; bills: number; plates: number; revenue: number }>
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const cur = rangeToDates(range);
        const [res, hours] = await Promise.all([
          window.api.analytics.summary({ from: cur.from, to: cur.to }),
          window.api.analytics.hourly({ from: cur.from, to: cur.to }),
        ]);
        setData(res);
        setHourly(hours);

        const prevRange = previousPeriod(range);
        if (prevRange) {
          const prevRes = await window.api.analytics.summary(prevRange);
          setPrev(prevRes.total);
        } else {
          setPrev(null);
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [range]);

  const total = data?.total ?? { bills: 0, plates: 0, revenue: 0 };
  const byMeal: any[] = data?.byMeal ?? [];
  const byPayment: any[] = data?.byPayment ?? [];
  const daily: any[] = data?.daily ?? [];

  const mealPie = useMemo(
    () =>
      byMeal.map((m) => ({
        name: m.meal_type === 'lunch' ? 'Lunch' : 'Dinner',
        value: m.revenue,
      })),
    [byMeal]
  );

  const paymentPie = useMemo(
    () =>
      byPayment.map((p) => ({
        name: p.payment_mode === 'cash' ? 'Cash' : 'UPI',
        value: p.revenue,
      })),
    [byPayment]
  );

  const hourlyChart = useMemo(
    () =>
      hourly.map((h) => ({
        hour: `${h.hour.toString().padStart(2, '0')}:00`,
        plates: h.plates,
        revenue: h.revenue,
        bills: h.bills,
      })),
    [hourly]
  );

  const peakHour = useMemo(() => {
    if (hourly.length === 0) return null;
    let best = hourly[0];
    for (const h of hourly) if (h.plates > best.plates) best = h;
    return best.plates > 0 ? best : null;
  }, [hourly]);

  const ranges: { key: Range; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7 Days' },
    { key: '30d', label: '30 Days' },
    { key: 'mtd', label: 'This Month' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Analytics</h1>
        <div className="flex gap-2">
          {ranges.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                range === r.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-white border border-gray-300 hover:bg-gray-100'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI cards with previous-period delta */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Kpi
          label="Revenue"
          value={`₹${total.revenue.toLocaleString()}`}
          accent="brand"
          delta={deltaPct(total.revenue, prev?.revenue)}
        />
        <Kpi
          label="Bills"
          value={total.bills.toString()}
          accent="blue"
          delta={deltaPct(total.bills, prev?.bills)}
        />
        <Kpi
          label="Plates Sold"
          value={total.plates.toString()}
          accent="green"
          delta={deltaPct(total.plates, prev?.plates)}
        />
      </div>

      <Suspense
        fallback={<div className="text-center text-sm text-gray-500 py-8">Loading charts…</div>}
      >
        <AnalyticsCharts
          mealPie={mealPie}
          paymentPie={paymentPie}
          hourlyChart={hourlyChart}
          daily={daily}
          peakHour={peakHour}
        />
      </Suspense>

      {loading && <div className="mt-4 text-center text-sm text-gray-500">Loading…</div>}
    </div>
  );
}

function deltaPct(current: number, previous: number | undefined): number | null {
  if (previous === undefined) return null;
  if (previous === 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

function Kpi({
  label,
  value,
  accent,
  delta,
}: {
  label: string;
  value: string;
  accent: string;
  delta: number | null;
}) {
  const colors: Record<string, string> = {
    brand: 'from-orange-500 to-orange-600',
    blue: 'from-blue-500 to-blue-600',
    green: 'from-green-500 to-green-600',
  };
  return (
    <div className={`p-5 rounded-2xl bg-gradient-to-br ${colors[accent]} text-white shadow-md`}>
      <div className="text-sm opacity-90">{label}</div>
      <div className="text-3xl font-bold mt-1">{value}</div>
      {delta !== null && (
        <div className="text-xs mt-1 opacity-90">
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs previous period
        </div>
      )}
    </div>
  );
}

