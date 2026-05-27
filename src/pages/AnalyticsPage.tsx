import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Range = 'today' | '7d' | '30d' | 'mtd' | 'all';

function rangeToDates(r: Range): { from: string; to: string; label: string } {
  const now = new Date();
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  switch (r) {
    case 'today':
      from.setDate(to.getDate() - 1);
      return { from: from.toISOString(), to: to.toISOString(), label: 'Today' };
    case '7d':
      from.setDate(to.getDate() - 7);
      return { from: from.toISOString(), to: to.toISOString(), label: 'Last 7 days' };
    case '30d':
      from.setDate(to.getDate() - 30);
      return { from: from.toISOString(), to: to.toISOString(), label: 'Last 30 days' };
    case 'mtd':
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      return { from: from.toISOString(), to: to.toISOString(), label: 'Month to date' };
    case 'all':
      return { from: '1970-01-01T00:00:00Z', to: to.toISOString(), label: 'All time' };
  }
}

// Returns the immediately preceding period of the same length, useful for
// delta-vs-previous-period comparisons. "All" has no meaningful previous period.
function previousPeriod(r: Range): { from: string; to: string } | null {
  if (r === 'all') return null;
  const cur = rangeToDates(r);
  const curFrom = new Date(cur.from);
  const curTo = new Date(cur.to);
  const span = curTo.getTime() - curFrom.getTime();
  const prevTo = new Date(curFrom);
  const prevFrom = new Date(curFrom.getTime() - span);
  return { from: prevFrom.toISOString(), to: prevTo.toISOString() };
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

  const MEAL_COLORS = ['#facc15', '#6366f1'];
  const PAY_COLORS = ['#22c55e', '#3b82f6'];

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

      {/* Charts row */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card title="Revenue by Meal">
          {mealPie.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={mealPie} dataKey="value" nameKey="name" outerRadius={80} label>
                  {mealPie.map((_, i) => (
                    <Cell key={i} fill={MEAL_COLORS[i % MEAL_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: any) => `₹${v}`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Revenue by Payment Mode">
          {paymentPie.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={paymentPie} dataKey="value" nameKey="name" outerRadius={80} label>
                  {paymentPie.map((_, i) => (
                    <Cell key={i} fill={PAY_COLORS[i % PAY_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: any) => `₹${v}`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Hour-of-day */}
      <div className="mb-6">
        <Card
          title={
            peakHour
              ? `Plates by Hour — peak at ${peakHour.hour
                  .toString()
                  .padStart(2, '0')}:00 (${peakHour.plates} plates)`
              : 'Plates by Hour'
          }
        >
          {hourlyChart.every((h) => h.plates === 0) ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={hourlyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} interval={1} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="plates"
                  stroke="#ea580c"
                  strokeWidth={2}
                  dot={false}
                  name="Plates"
                />
                <Line
                  type="monotone"
                  dataKey="bills"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Bills"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Daily revenue */}
      <Card title="Daily Revenue">
        {daily.length === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: any) => `₹${v}`} />
              <Legend />
              <Bar dataKey="revenue" fill="#ea580c" name="Revenue (₹)" />
              <Bar dataKey="plates" fill="#3b82f6" name="Plates" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Empty() {
  return (
    <div className="h-[240px] flex items-center justify-center text-sm text-gray-400">
      No data in this range.
    </div>
  );
}
