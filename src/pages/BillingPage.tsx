import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { PaymentMode } from '../types';
import DaySummaryModal from '../components/DaySummaryModal';
import VoidBillModal from '../components/VoidBillModal';

const QUICK_PLATES = [1, 2, 3, 4, 5, 6, 7, 8];

// SQLite stores created_at as "YYYY-MM-DD HH:MM:SS" (UTC, no Z marker), which
// JS's Date() parses as local — so a 14:30 IST bill prints/displays as 09:00.
// Append 'T' + 'Z' so it's read as UTC and the local-time helpers shift it
// back to wall-clock hours correctly.
function parseDbDate(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

export default function BillingPage() {
  const mealType = useApp((s) => s.mealType);
  const user = useApp((s) => s.user);
  // Admin-only "test mode": submit prints the slip but skips DB write, audit
  // log, and Supabase sync. Session-only — toggle resets on reload so a forgotten
  // toggle can't silently swallow real sales.
  const [testMode, setTestMode] = useState(false);
  const [plates, setPlates] = useState(1);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [prices, setPrices] = useState<{ lunch: number; dinner: number }>({ lunch: 0, dinner: 0 });
  const [busy, setBusy] = useState(false);
  const [lastBill, setLastBill] = useState<{
    id: string;
    tokenNo: number;
    plates: number;
    total: number;
    mealType: string;
    paymentMode: string;
    printError?: string;
  } | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [tokenSearch, setTokenSearch] = useState('');
  const [searchHits, setSearchHits] = useState<any[] | null>(null);
  const [extras, setExtras] = useState<
    Array<{ id: string; name: string; unitPrice: number; active: number; sortOrder: number }>
  >([]);
  // qty per extra id, only stored when > 0
  const [extraQty, setExtraQty] = useState<Record<string, number>>({});
  const setQty = (id: string, q: number) =>
    setExtraQty((prev) => {
      const next = { ...prev };
      if (q <= 0) delete next[id];
      else next[id] = q;
      return next;
    });
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
  const refreshExtras = async () => setExtras(await window.api.extras.list());
  const refreshRecent = async () => {
    // All of today's bills, newest first. IPC's default LIMIT is 1000 which
    // is far more than a single restaurant produces in a day.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const list = await window.api.bills.list({ from: today.toISOString() });
    setRecent(list);
  };
  const refreshStats = async () => setStats(await window.api.stats.today());

  // Token-number lookup. Token numbers reset each day, so a search may return
  // multiple rows (one per day with that number) — newest first via the IPC's
  // ORDER BY created_at DESC. Empty input clears the search and reverts to
  // the today-only recent list.
  const runTokenSearch = async (raw: string) => {
    const n = Number(raw.trim());
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) {
      setSearchHits(null);
      return;
    }
    const list = await window.api.bills.list({ tokenNo: Math.floor(n), limit: 50 });
    setSearchHits(list);
  };

  useEffect(() => {
    refreshPrices();
    refreshRecent();
    refreshStats();
    refreshExtras();
  }, []);

  const pricePerPlate = prices[mealType];
  const thaliSubtotal = pricePerPlate * plates;
  const extrasSubtotal = extras.reduce(
    (s, x) => s + (extraQty[x.id] ?? 0) * x.unitPrice,
    0
  );
  const total = thaliSubtotal + extrasSubtotal;

  const submit = async () => {
    if (busy || plates < 1) return;
    setBusy(true);
    try {
      const extrasPayload = Object.entries(extraQty)
        .filter(([, q]) => q > 0)
        .map(([extraId, qty]) => ({ extraId, qty }));
      if (testMode) {
        const r = await window.api.bills.testPrint({
          plates,
          mealType,
          paymentMode,
          extras: extrasPayload,
        });
        if (r.ok) {
          // Reset the form so the admin can iterate quickly without leftover
          // state from the prior test slip.
          setPlates(1);
          setPaymentMode('cash');
          setExtraQty({});
        } else {
          alert(`Test print failed: ${r.error ?? 'unknown'}`);
        }
        return;
      }
      const res = await window.api.bills.create({
        plates,
        mealType,
        paymentMode,
        extras: extrasPayload,
      });
      if (res.ok && res.bill) {
        setLastBill({
          id: res.bill.id,
          tokenNo: res.bill.tokenNo,
          plates: res.bill.plates,
          total: res.bill.total,
          mealType: res.bill.mealType,
          paymentMode: res.bill.paymentMode,
          printError: res.printError,
        });
        setPlates(1);
        setPaymentMode('cash');
        setExtraQty({});
        refreshRecent();
        refreshStats();
        // Print failures stay on-screen until dismissed; successful prints
        // auto-clear so the next sale isn't crowded by stale confirmations.
        if (!res.printError) {
          setTimeout(() => setLastBill(null), 4000);
        }
      } else {
        alert(res.error ?? 'Failed to create bill');
      }
    } finally {
      setBusy(false);
    }
  };

  const reprintLast = async () => {
    if (!lastBill) return;
    const r = await window.api.printer.reprint(lastBill.id);
    if (r && (r as any).ok === false) {
      alert(`Reprint failed: ${(r as any).error ?? 'unknown error'}`);
      return;
    }
    setLastBill({ ...lastBill, printError: undefined });
    setTimeout(() => setLastBill(null), 4000);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when a modal is open — those have their own focused controls.
      if (showSummary || voidTarget) return;
      // Skip when typing into a field (defensive — billing page has none today,
      // but future inputs shouldn't break).
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Digits 1–8 set plate count directly.
      if (/^[1-8]$/.test(e.key)) {
        setPlates(Number(e.key));
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case '+':
        case '=':
          setPlates((p) => p + 1);
          e.preventDefault();
          break;
        case '-':
          setPlates((p) => Math.max(1, p - 1));
          e.preventDefault();
          break;
        case 'c':
        case 'C':
          setPaymentMode('cash');
          e.preventDefault();
          break;
        case 'u':
        case 'U':
          setPaymentMode('upi');
          e.preventDefault();
          break;
        case 'Enter':
          submit();
          e.preventDefault();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSummary, voidTarget, busy, plates, mealType, paymentMode, pricePerPlate]);

  return (
    <div className="h-full flex flex-col">
      {testMode && (
        <div className="bg-amber-500 text-white text-center py-2 text-sm font-semibold tracking-wide">
          🧪 TEST MODE — bills are NOT saved or synced. Printer test only.
        </div>
      )}
      <div className="flex-1 flex min-h-0">
      {/* LEFT: Quick plate-count buttons (bigger section) */}
      <div className="flex-1 p-6 bg-white border-r overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">Select Plates</h2>
          <div className="flex items-center gap-3">
            <div className="text-sm text-gray-500 hidden xl:block">
              Tap a number, or press <kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">1</kbd>–<kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">8</kbd> ·{' '}
              <kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">C</kbd>/<kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">U</kbd> ·{' '}
              <kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">Enter</kbd>
            </div>
            {user?.role === 'admin' && (
              <label
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium cursor-pointer select-none ${
                  testMode
                    ? 'bg-amber-100 border-amber-400 text-amber-900'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                title="Print without saving to DB or syncing — for testing"
              >
                <input
                  type="checkbox"
                  checked={testMode}
                  onChange={(e) => setTestMode(e.target.checked)}
                  className="accent-amber-600"
                />
                Test mode
              </label>
            )}
            <button
              onClick={() => setShowSummary(true)}
              className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-medium"
            >
              📊 Day Summary
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {QUICK_PLATES.map((n) => (
            <button
              key={n}
              onClick={() => setPlates(n)}
              className={`h-20 rounded-xl border-2 text-2xl font-bold transition-all shadow-sm ${
                plates === n
                  ? 'bg-brand-600 text-white border-brand-700 scale-95'
                  : 'bg-gradient-to-br from-orange-50 to-orange-100 text-brand-700 border-orange-200 hover:from-orange-100 hover:to-orange-200 active:scale-95'
              }`}
            >
              <div>{n}</div>
              <div className="text-[10px] font-normal opacity-75 mt-0.5">
                {n === 1 ? 'plate' : 'plates'}
              </div>
            </button>
          ))}
        </div>

        {/* Extras (managed in Menu page) */}
        {extras.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Extras</h3>
            <div className="grid grid-cols-3 gap-3">
              {extras.map((x) => {
                const q = extraQty[x.id] ?? 0;
                return (
                  <div
                    key={x.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border ${
                      q > 0
                        ? 'bg-orange-50 border-orange-300'
                        : 'bg-white border-gray-200'
                    }`}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium truncate">{x.name}</span>
                      <span className="text-xs text-gray-500 tabular-nums">₹{x.unitPrice}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setQty(x.id, Math.max(0, q - 1))}
                        disabled={q === 0}
                        className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 disabled:opacity-40 text-lg font-bold"
                      >
                        −
                      </button>
                      <span className="w-6 text-center tabular-nums font-semibold">{q}</span>
                      <button
                        onClick={() => setQty(x.id, q + 1)}
                        className="w-8 h-8 rounded-full bg-brand-600 hover:bg-brand-700 text-white text-lg font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* All bills, newest first */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-600">
              {searchHits !== null
                ? `Search results for token #${tokenSearch.trim()}`
                : `Today's bills (${recent.length})`}
            </h3>
            <input
              type="text"
              inputMode="numeric"
              value={tokenSearch}
              onChange={(e) => {
                setTokenSearch(e.target.value);
                runTokenSearch(e.target.value);
              }}
              placeholder="Find token #"
              className="px-2 py-1 text-sm border border-gray-300 rounded w-40"
            />
          </div>
          <div className="bg-gray-50 rounded-lg border border-gray-200 max-h-96 overflow-auto">
            {(searchHits ?? recent).length === 0 && (
              <div className="p-4 text-sm text-gray-400">
                {searchHits !== null ? 'No bills with that token number.' : 'No bills yet today.'}
              </div>
            )}
            {(searchHits ?? recent).map((b) => {
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
                      {searchHits !== null
                        ? new Date(parseDbDate(b.created_at)).toLocaleString([], {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : new Date(parseDbDate(b.created_at)).toLocaleTimeString([], {
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
            {extrasSubtotal > 0 && ` + ₹${extrasSubtotal} extras`}
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

        {lastBill && !lastBill.printError && (
          <div className="mt-3 p-3 rounded-lg bg-green-50 border border-green-300 text-green-800 text-sm text-center">
            ✓ Token #{lastBill.tokenNo} printed — {lastBill.plates} plates, ₹{lastBill.total} (
            {lastBill.paymentMode})
          </div>
        )}

        {lastBill && lastBill.printError && (
          <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-300 text-red-800 text-sm">
            <div className="font-semibold">
              ⚠ Token #{lastBill.tokenNo} saved, but print FAILED
            </div>
            <div className="text-xs text-red-700 mt-1 break-words">{lastBill.printError}</div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={reprintLast}
                className="px-3 py-1.5 rounded bg-red-600 text-white text-xs font-semibold hover:bg-red-700"
              >
                Reprint
              </button>
              <button
                onClick={() => setLastBill(null)}
                className="px-3 py-1.5 rounded border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-100"
              >
                Dismiss
              </button>
            </div>
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
    </div>
  );
}
