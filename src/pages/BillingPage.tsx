import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { PaymentMode } from '../types';
import DaySummaryModal from '../components/DaySummaryModal';
import VoidBillModal from '../components/VoidBillModal';

const QUICK_PLATES = [1, 2, 3, 4, 5, 6, 7, 8];

export default function BillingPage() {
  const mealType = useApp((s) => s.mealType);
  const [plates, setPlates] = useState(1);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [prices, setPrices] = useState<{ lunch: number; dinner: number }>({ lunch: 0, dinner: 0 });
  const [busy, setBusy] = useState(false);
  const [lastBill, setLastBill] = useState<{
    tokenNo: number;
    plates: number;
    total: number;
    mealType: string;
    paymentMode: string;
  } | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [stats, setStats] = useState<{
    nextTokenNo: number;
    bills: number;
    plates: number;
    revenue: number;
    cash: number;
    upi: number;
  }>({ nextTokenNo: 1, bills: 0, plates: 0, revenue: 0, cash: 0, upi: 0 });
  const [showSummary, setShowSummary] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    token_no: number;
    plates: number;
    total: number;
  } | null>(null);

  const refreshPrices = async () => setPrices(await window.api.prices.get());
  const refreshRecent = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const list = await window.api.bills.list({ from: today.toISOString(), limit: 10 });
    setRecent(list);
  };
  const refreshStats = async () => setStats(await window.api.stats.today());

  useEffect(() => {
    refreshPrices();
    refreshRecent();
    refreshStats();
  }, []);

  const pricePerPlate = prices[mealType];
  const total = pricePerPlate * plates;

  const submit = async () => {
    if (busy || plates < 1) return;
    setBusy(true);
    try {
      const res = await window.api.bills.create({ plates, mealType, paymentMode });
      if (res.ok && res.bill) {
        setLastBill({
          tokenNo: res.bill.tokenNo,
          plates: res.bill.plates,
          total: res.bill.total,
          mealType: res.bill.mealType,
          paymentMode: res.bill.paymentMode,
        });
        setPlates(1);
        setPaymentMode('cash');
        refreshRecent();
        refreshStats();
        setTimeout(() => setLastBill(null), 4000);
      } else {
        alert(res.error ?? 'Failed to create bill');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex">
      {/* LEFT: Quick plate-count buttons (bigger section) */}
      <div className="flex-1 p-6 bg-white border-r overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">Select Plates</h2>
          <div className="flex items-center gap-3">
            <div className="text-sm text-gray-500 hidden xl:block">
              Tap a number to set plate count, or use +/−
            </div>
            <button
              onClick={() => setShowSummary(true)}
              className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-medium"
            >
              📊 Day Summary
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          {QUICK_PLATES.map((n) => (
            <button
              key={n}
              onClick={() => setPlates(n)}
              className={`aspect-square rounded-2xl border-2 text-3xl font-bold transition-all shadow-sm ${
                plates === n
                  ? 'bg-brand-600 text-white border-brand-700 scale-95'
                  : 'bg-gradient-to-br from-orange-50 to-orange-100 text-brand-700 border-orange-200 hover:from-orange-100 hover:to-orange-200 active:scale-95'
              }`}
            >
              <div>{n}</div>
              <div className="text-xs font-normal opacity-75">
                {n === 1 ? 'plate' : 'plates'}
              </div>
            </button>
          ))}
        </div>

        {/* Recent bills today */}
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-gray-600 mb-2">Today's recent tokens</h3>
          <div className="bg-gray-50 rounded-lg border border-gray-200 max-h-44 overflow-auto">
            {recent.length === 0 && (
              <div className="p-4 text-sm text-gray-400">No bills yet today.</div>
            )}
            {recent.map((b) => {
              const isVoided = !!b.voided_at;
              return (
                <div
                  key={b.id}
                  className={`flex items-center justify-between px-3 py-2 border-b last:border-b-0 text-sm ${
                    isVoided ? 'bg-red-50/60' : ''
                  }`}
                >
                  <div
                    className={`flex items-center gap-3 ${
                      isVoided ? 'line-through text-gray-400' : ''
                    }`}
                  >
                    <span className={isVoided ? 'font-bold' : 'font-bold text-brand-700'}>
                      #{b.token_no}
                    </span>
                    <span className="text-gray-500">
                      {new Date(b.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="text-xs uppercase text-gray-400">{b.meal_type}</span>
                    <span>{b.plates} plates</span>
                    <span className="font-semibold">₹{b.total}</span>
                    <span className="text-xs text-gray-500">{b.payment_mode}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isVoided ? (
                      <span
                        className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 font-semibold"
                        title={b.void_reason ?? 'Voided'}
                      >
                        VOIDED
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => window.api.printer.reprint(b.id)}
                          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-white"
                        >
                          Reprint
                        </button>
                        <button
                          onClick={() =>
                            setVoidTarget({
                              id: b.id,
                              token_no: b.token_no,
                              plates: b.plates,
                              total: b.total,
                            })
                          }
                          className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
                        >
                          Void
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT: Counter + payment */}
      <div className="w-[420px] flex flex-col p-6 bg-gradient-to-b from-gray-50 to-white">
        {/* Quick stats — today's running totals */}
        <div className="mb-3 rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          <div className="grid grid-cols-2 divide-x divide-gray-200">
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Next Token</div>
              <div className="text-2xl font-bold text-brand-700 tabular-nums leading-tight">
                #{stats.nextTokenNo}
              </div>
            </div>
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Plates Today</div>
              <div className="text-2xl font-bold text-gray-800 tabular-nums leading-tight">
                {stats.plates}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-gray-200 border-t border-gray-200">
            <div className="px-3 py-1.5 bg-green-50">
              <div className="text-[10px] uppercase tracking-wider text-green-700">Cash</div>
              <div className="text-sm font-bold text-green-800 tabular-nums leading-tight">
                ₹{stats.cash.toLocaleString()}
              </div>
            </div>
            <div className="px-3 py-1.5 bg-blue-50">
              <div className="text-[10px] uppercase tracking-wider text-blue-700">UPI</div>
              <div className="text-sm font-bold text-blue-800 tabular-nums leading-tight">
                ₹{stats.upi.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        <div
          className={`mb-3 px-3 py-2 rounded-lg text-center font-semibold text-sm ${
            mealType === 'lunch'
              ? 'bg-yellow-100 text-yellow-900'
              : 'bg-indigo-100 text-indigo-900'
          }`}
        >
          {mealType === 'lunch' ? '☀ LUNCH' : '☾ DINNER'} — ₹{pricePerPlate}/plate
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Plates</div>
          <div className="flex items-center justify-between mt-2">
            <button
              onClick={() => setPlates((p) => Math.max(1, p - 1))}
              className="w-16 h-16 rounded-full bg-gray-200 hover:bg-gray-300 active:bg-gray-400 text-3xl font-bold"
            >
              −
            </button>
            <div className="text-6xl font-bold text-gray-800 tabular-nums">{plates}</div>
            <button
              onClick={() => setPlates((p) => p + 1)}
              className="w-16 h-16 rounded-full bg-brand-600 hover:bg-brand-700 active:bg-brand-700 text-white text-3xl font-bold"
            >
              +
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Total</div>
          <div className="text-5xl font-bold text-brand-700 tabular-nums mt-1">₹{total}</div>
          <div className="text-xs text-gray-400 mt-1">
            {plates} × ₹{pricePerPlate}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Payment Mode</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setPaymentMode('cash')}
              className={`py-4 rounded-xl border-2 font-semibold transition ${
                paymentMode === 'cash'
                  ? 'bg-green-500 text-white border-green-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
              }`}
            >
              💵 Cash
            </button>
            <button
              onClick={() => setPaymentMode('upi')}
              className={`py-4 rounded-xl border-2 font-semibold transition ${
                paymentMode === 'upi'
                  ? 'bg-blue-500 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
              }`}
            >
              📱 UPI
            </button>
          </div>
        </div>

        <button
          onClick={submit}
          disabled={busy || plates < 1 || pricePerPlate <= 0}
          className="mt-auto py-5 rounded-2xl bg-brand-600 hover:bg-brand-700 active:bg-brand-700 disabled:opacity-50 text-white text-xl font-bold shadow-lg"
        >
          {busy ? 'Printing…' : 'Print Token & Save'}
        </button>

        {lastBill && (
          <div className="mt-3 p-3 rounded-lg bg-green-50 border border-green-300 text-green-800 text-sm text-center">
            ✓ Token #{lastBill.tokenNo} printed — {lastBill.plates} plates, ₹{lastBill.total} (
            {lastBill.paymentMode})
          </div>
        )}
      </div>

      {showSummary && <DaySummaryModal onClose={() => setShowSummary(false)} />}

      {voidTarget && (
        <VoidBillModal
          bill={voidTarget}
          onClose={() => setVoidTarget(null)}
          onVoided={() => {
            refreshRecent();
            refreshStats();
          }}
        />
      )}
    </div>
  );
}
