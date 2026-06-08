import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

// Recharts is ~150 KB minified-gzipped. Lazy-loading the chart component
// keeps it out of the initial billing-page bundle so first paint stays fast;
// the chunk only fetches when an admin first opens Analytics.
const AnalyticsCharts = lazy(() => import('./AnalyticsCharts'));

type PresetKey =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'mtd'
  | 'lastMonth'
  | 'all'
  | 'custom';

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" (space, no Z).
// Range bounds must be sent in the same shape so the WHERE created_at >= ?
// lexicographic comparison lines up.
function toSqliteUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// Local-day midnight helpers — work in the system timezone (IST for the
// shop), so the "today" boundary matches the cashier's wall clock.
function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function localISO(d: Date): string {
  // YYYY-MM-DD in local timezone — what HTML <input type="date"> expects.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateFromIso(iso: string): Date {
  // "YYYY-MM-DD" → midnight local. Construct via setFullYear so we don't get
  // tripped up by JS interpreting the literal string as UTC midnight.
  const [y, m, d] = iso.split('-').map(Number);
  const out = new Date();
  out.setFullYear(y, m - 1, d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function applyPreset(key: PresetKey, customFrom?: Date, customTo?: Date): {
  from: Date;
  to: Date;
} {
  const today = startOfLocalDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  switch (key) {
    case 'today':
      return { from: today, to: tomorrow };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(today.getDate() - 1);
      return { from: y, to: today };
    }
    case '7d': {
      const f = new Date(today);
      f.setDate(today.getDate() - 6);
      return { from: f, to: tomorrow };
    }
    case '30d': {
      const f = new Date(today);
      f.setDate(today.getDate() - 29);
      return { from: f, to: tomorrow };
    }
    case 'mtd': {
      const f = new Date(today);
      f.setDate(1);
      return { from: f, to: tomorrow };
    }
    case 'lastMonth': {
      const f = new Date(today);
      f.setDate(1);
      f.setMonth(f.getMonth() - 1);
      const t = new Date(today);
      t.setDate(1);
      return { from: f, to: t };
    }
    case 'all': {
      const f = new Date('1970-01-01T00:00:00Z');
      return { from: f, to: tomorrow };
    }
    case 'custom':
      return {
        from: customFrom ?? today,
        // Custom range's "to" is inclusive of the picked date, so add a day
        // for the half-open interval the IPC expects.
        to: customTo
          ? (() => {
              const t = new Date(customTo);
              t.setDate(t.getDate() + 1);
              return t;
            })()
          : tomorrow,
      };
  }
}

// For previous-period delta on KPI cards.
function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - span);
  return { from: prevFrom, to: prevTo };
}

export default function AnalyticsPage() {
  const initial = applyPreset('today');
  const [presetKey, setPresetKey] = useState<PresetKey>('today');
  const [from, setFrom] = useState<Date>(initial.from);
  const [to, setTo] = useState<Date>(initial.to);

  const [data, setData] = useState<any>(null);
  const [prev, setPrev] = useState<{
    bills: number;
    plates: number;
    revenue: number;
  } | null>(null);
  const [hourly, setHourly] = useState<
    Array<{ hour: number; bills: number; plates: number; revenue: number }>
  >([]);
  const [items, setItems] = useState<
    Array<{ name: string; qty: number; revenue: number; plates: number }>
  >([]);
  const [weekday, setWeekday] = useState<
    Array<{ weekday: number; bills: number; plates: number; revenue: number }>
  >([]);
  const [loading, setLoading] = useState(false);

  const setPreset = (key: PresetKey) => {
    if (key === 'custom') {
      setPresetKey('custom');
      return;
    }
    const { from: f, to: t } = applyPreset(key);
    setPresetKey(key);
    setFrom(f);
    setTo(t);
  };

  const setCustomFrom = (iso: string) => {
    if (!iso) return;
    setPresetKey('custom');
    setFrom(dateFromIso(iso));
  };

  const setCustomTo = (iso: string) => {
    if (!iso) return;
    setPresetKey('custom');
    const picked = dateFromIso(iso);
    // The IPC half-open interval expects to-date+1 day. We store that here so
    // queries are correct, and convert back when displaying in the picker.
    const t = new Date(picked);
    t.setDate(t.getDate() + 1);
    setTo(t);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const fromStr = toSqliteUtc(from);
        const toStr = toSqliteUtc(to);
        const [res, hours, topItems, byDay] = await Promise.all([
          window.api.analytics.summary({ from: fromStr, to: toStr }),
          window.api.analytics.hourly({ from: fromStr, to: toStr }),
          window.api.analytics.items({ from: fromStr, to: toStr }),
          window.api.analytics.weekday({ from: fromStr, to: toStr }),
        ]);
        setData(res);
        setHourly(hours);
        setItems(topItems);
        setWeekday(byDay);

        const prevRange = previousPeriod(from, to);
        const prevRes = await window.api.analytics.summary({
          from: toSqliteUtc(prevRange.from),
          to: toSqliteUtc(prevRange.to),
        });
        setPrev(prevRes.total);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [from, to]);

  const total = data?.total ?? { bills: 0, plates: 0, revenue: 0 };
  const byMeal: any[] = data?.byMeal ?? [];
  const byPayment: any[] = data?.byPayment ?? [];
  const daily: any[] = data?.daily ?? [];

  const avgBill = total.bills > 0 ? Math.round(total.revenue / total.bills) : 0;
  const avgPlatesPerBill =
    total.bills > 0 ? (total.plates / total.bills).toFixed(1) : '0';

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

  // Weekday labels match JS Date.getDay() / SQLite strftime('%w'):
  // 0=Sun, 1=Mon, ..., 6=Sat. Shop runs Mon-Sun typically; reorder so the
  // bar chart starts on Monday.
  const weekdayChart = useMemo(() => {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
    return order.map((w) => {
      const row = weekday.find((r) => r.weekday === w);
      return {
        day: labels[w],
        revenue: row?.revenue ?? 0,
        bills: row?.bills ?? 0,
        plates: row?.plates ?? 0,
      };
    });
  }, [weekday]);

  const bestDay = useMemo(() => {
    if (daily.length === 0) return null;
    return daily.reduce(
      (best: any, d: any) => (d.revenue > (best?.revenue ?? -1) ? d : best),
      null as any
    );
  }, [daily]);

  // For the "to" date input — back out the +1 day we added internally.
  const toIsoForPicker = useMemo(() => {
    const display = new Date(to);
    display.setDate(display.getDate() - 1);
    return localISO(display);
  }, [to]);

  const presets: { key: PresetKey; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: '7d', label: '7 Days' },
    { key: '30d', label: '30 Days' },
    { key: 'mtd', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Analytics</h1>
        <div className="flex gap-2 flex-wrap">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                presetKey === p.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-white border border-gray-300 hover:bg-gray-100'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom range picker */}
      <div className="flex items-center gap-3 mb-6 p-3 rounded-lg bg-white border border-gray-200">
        <span className="text-xs uppercase tracking-wider text-gray-500">Custom range</span>
        <input
          type="date"
          value={localISO(from)}
          max={toIsoForPicker}
          onChange={(e) => setCustomFrom(e.target.value)}
          className="px-2 py-1 border border-gray-300 rounded text-sm"
        />
        <span className="text-gray-400 text-sm">→</span>
        <input
          type="date"
          value={toIsoForPicker}
          max={localISO(new Date())}
          onChange={(e) => setCustomTo(e.target.value)}
          className="px-2 py-1 border border-gray-300 rounded text-sm"
        />
        {presetKey === 'custom' && (
          <span className="ml-auto text-xs text-brand-700 font-semibold">Custom</span>
        )}
      </div>

      {/* KPI cards with previous-period delta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
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
        <Kpi
          label="Avg Bill"
          value={`₹${avgBill.toLocaleString()}`}
          accent="purple"
          subtitle={`${avgPlatesPerBill} plates/bill`}
        />
      </div>

      {/* Top items leaderboard + Best day callout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Top items by revenue</h3>
          {items.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">
              No items sold in this range.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {items.slice(0, 10).map((it, i) => {
                const max = items[0].revenue || 1;
                const pct = (it.revenue / max) * 100;
                return (
                  <div key={it.name} className="py-2">
                    <div className="flex items-baseline gap-3 text-sm">
                      <span className="text-gray-400 w-6 tabular-nums">{i + 1}.</span>
                      <span className="font-semibold flex-1 truncate">{it.name}</span>
                      <span className="text-gray-500 tabular-nums">
                        {it.qty} sold
                      </span>
                      <span className="font-bold tabular-nums w-24 text-right">
                        ₹{it.revenue.toLocaleString()}
                      </span>
                    </div>
                    <div className="ml-9 mt-1 h-1.5 bg-gray-100 rounded">
                      <div
                        className="h-1.5 rounded bg-brand-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Highlights</h3>
          <div className="space-y-3 text-sm">
            <Highlight
              label="Best day"
              value={
                bestDay
                  ? `${formatShortDate(bestDay.day)} — ₹${bestDay.revenue.toLocaleString()}`
                  : '—'
              }
              icon="🏆"
            />
            <Highlight
              label="Peak hour"
              value={
                peakHour
                  ? `${peakHour.hour.toString().padStart(2, '0')}:00 — ${peakHour.plates} plates`
                  : '—'
              }
              icon="⏰"
            />
            <Highlight
              label="Items in range"
              value={items.length === 0 ? '—' : `${items.length} distinct`}
              icon="📋"
            />
            <Highlight
              label="Range span"
              value={`${spanDays(from, to)} day${spanDays(from, to) === 1 ? '' : 's'}`}
              icon="📅"
            />
          </div>
        </div>
      </div>

      <Suspense
        fallback={
          <div className="text-center text-sm text-gray-500 py-8">Loading charts…</div>
        }
      >
        <AnalyticsCharts
          mealPie={mealPie}
          paymentPie={paymentPie}
          hourlyChart={hourlyChart}
          daily={daily}
          peakHour={peakHour}
          weekdayChart={weekdayChart}
        />
      </Suspense>

      {loading && <div className="mt-4 text-center text-sm text-gray-500">Loading…</div>}
    </div>
  );
}

function spanDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function formatShortDate(iso: string): string {
  // iso is "YYYY-MM-DD" from SQLite date(...)
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
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
  subtitle,
}: {
  label: string;
  value: string;
  accent: string;
  delta?: number | null;
  subtitle?: string;
}) {
  const colors: Record<string, string> = {
    brand: 'from-orange-500 to-orange-600',
    blue: 'from-blue-500 to-blue-600',
    green: 'from-green-500 to-green-600',
    purple: 'from-purple-500 to-purple-600',
    red: 'from-red-500 to-red-600',
  };
  return (
    <div
      className={`p-4 rounded-2xl bg-gradient-to-br ${colors[accent]} text-white shadow-md`}
    >
      <div className="text-xs opacity-90 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {delta !== null && delta !== undefined && (
        <div className="text-xs mt-1 opacity-90">
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs prev
        </div>
      )}
      {subtitle && <div className="text-xs mt-1 opacity-90">{subtitle}</div>}
    </div>
  );
}

function Highlight({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xl">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
        <div className="font-semibold text-gray-800 truncate">{value}</div>
      </div>
    </div>
  );
}
