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

const MEAL_COLORS = ['#facc15', '#6366f1'];
const PAY_COLORS = ['#22c55e', '#3b82f6'];

type Slice = { name: string; value: number };
type HourPoint = { hour: string; plates: number; revenue: number; bills: number };
type PeakHour = { hour: number; plates: number } | null;
type WeekdayPoint = { day: string; revenue: number; bills: number; plates: number };

export default function AnalyticsCharts({
  mealPie,
  paymentPie,
  hourlyChart,
  daily,
  peakHour,
  weekdayChart,
}: {
  mealPie: Slice[];
  paymentPie: Slice[];
  hourlyChart: HourPoint[];
  daily: any[];
  peakHour: PeakHour;
  weekdayChart: WeekdayPoint[];
}) {
  return (
    <>
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

      <div className="mt-4">
        <Card title="Weekday pattern">
          {weekdayChart.every((d) => d.revenue === 0) ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weekdayChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(v: any, k: any) =>
                    k === 'Revenue (₹)' ? `₹${v}` : v
                  }
                />
                <Legend />
                <Bar dataKey="revenue" fill="#8b5cf6" name="Revenue (₹)" />
                <Bar dataKey="plates" fill="#10b981" name="Plates" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>
    </>
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
