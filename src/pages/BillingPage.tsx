import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import type { PaymentMode } from '../types';
import DaySummaryModal from '../components/DaySummaryModal';
import VoidBillModal from '../components/VoidBillModal';

// SQLite stores created_at as "YYYY-MM-DD HH:MM:SS" (UTC, no Z marker), which
// JS's Date() parses as local — so a 14:30 IST bill prints/displays as 09:00.
// Append 'T' + 'Z' so it's read as UTC and the local-time helpers shift it
// back to wall-clock hours correctly.
function parseDbDate(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

type Extra = {
  id: string;
  name: string;
  unitPrice: number;
  active: number;
  sortOrder: number;
  shortcutKey: string | null;
};

// pending state for two-stage keyboard input. itemId is 'thali' for the
// built-in Thali (which has fixed shortcut T) or an extra's id for catalog
// items. qtyStr is the in-progress digit accumulator.
type Pending = { itemId: string; qtyStr: string } | null;

const RESERVED_KEYS = new Set(['T', 'C', 'U']);

export default function BillingPage() {
  const mealType = useApp((s) => s.mealType);
  const user = useApp((s) => s.user);
  // Admin-only "test mode": submit prints the slip but skips DB write, audit
  // log, and Supabase sync. Session-only — toggle resets on reload so a forgotten
  // toggle can't silently swallow real sales.
  const [testMode, setTestMode] = useState(false);
  const [thaliQty, setThaliQty] = useState(0);
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
  const [extras, setExtras] = useState<Extra[]>([]);
  const [extraQty, setExtraQty] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Pending>(null);
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

  const setExtraQtyById = (id: string, q: number) =>
    setExtraQty((prev) => {
      const next = { ...prev };
      if (q <= 0) delete next[id];
      else next[id] = q;
      return next;
    });

  const setItemQty = (itemId: string, qty: number) => {
    if (itemId === 'thali') setThaliQty(Math.max(0, qty));
    else setExtraQtyById(itemId, Math.max(0, qty));
  };

  const refreshPrices = async () => setPrices(await window.api.prices.get());
  const refreshExtras = async () => setExtras(await window.api.extras.list());
  const refreshRecent = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const list = await window.api.bills.list({ from: today.toISOString() });
    setRecent(list);
  };
  const refreshStats = async () => setStats(await window.api.stats.today());

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
  const thaliLineTotal = pricePerPlate * thaliQty;

  // The bill view: ordered list of non-zero items (Thali first, then extras
  // in catalog sort order). Used by the right-panel breakdown and as the
  // single source of truth for total + submit gating.
  const billLines = useMemo(() => {
    const lines: Array<{
      itemId: string;
      name: string;
      qty: number;
      unitPrice: number;
      lineTotal: number;
      shortcutKey: string;
    }> = [];
    if (thaliQty > 0) {
      lines.push({
        itemId: 'thali',
        name: 'THALI',
        qty: thaliQty,
        unitPrice: pricePerPlate,
        lineTotal: thaliLineTotal,
        shortcutKey: 'T',
      });
    }
    for (const x of extras) {
      const q = extraQty[x.id] ?? 0;
      if (q > 0) {
        lines.push({
          itemId: x.id,
          name: x.name.toUpperCase(),
          qty: q,
          unitPrice: x.unitPrice,
          lineTotal: q * x.unitPrice,
          shortcutKey: x.shortcutKey ?? '',
        });
      }
    }
    return lines;
  }, [thaliQty, pricePerPlate, thaliLineTotal, extras, extraQty]);

  const total = billLines.reduce((s, l) => s + l.lineTotal, 0);
  const totalQty = billLines.reduce((s, l) => s + l.qty, 0);

  const clearBill = () => {
    setThaliQty(0);
    setExtraQty({});
    setPending(null);
    setPaymentMode('cash');
  };

  const submit = async () => {
    if (busy || total <= 0) return;
    setBusy(true);
    try {
      const extrasPayload = Object.entries(extraQty)
        .filter(([, q]) => q > 0)
        .map(([extraId, qty]) => ({ extraId, qty }));
      if (testMode) {
        const r = await window.api.bills.testPrint({
          plates: thaliQty,
          mealType,
          paymentMode,
          extras: extrasPayload,
        });
        if (r.ok) clearBill();
        else alert(`Test print failed: ${r.error ?? 'unknown'}`);
        return;
      }
      const res = await window.api.bills.create({
        plates: thaliQty,
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
        clearBill();
        refreshRecent();
        refreshStats();
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

  // Resolve a letter key to an item. Reserved letters (T/C/U) are handled
  // separately by the caller. Returns null if no item matches the key.
  const itemByKey = (k: string): { itemId: string } | null => {
    if (k === 'T') return { itemId: 'thali' };
    const ex = extras.find((e) => (e.shortcutKey ?? '').toUpperCase() === k);
    return ex ? { itemId: ex.id } : null;
  };

  // Apply pending.qtyStr to its item. Empty string is a no-op (just clears
  // pending). Used by the Enter-handler and the letter-switch path.
  const commitPending = (p: Pending): void => {
    if (!p) return;
    if (p.qtyStr === '') return;
    const n = Number(p.qtyStr);
    if (Number.isFinite(n) && n >= 0) setItemQty(p.itemId, n);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showSummary || voidTarget) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }

      // SAVE: Ctrl+Enter (or Cmd+Enter on macOS) is the only way to submit.
      // Plain Enter just commits a pending qty without saving — protects
      // against an accidental keystroke firing a real bill.
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (pending) {
          commitPending(pending);
          setPending(null);
        }
        // Defer submit a tick so any just-committed qty state has settled.
        setTimeout(() => {
          if (total > 0 || (pending && Number(pending.qtyStr) > 0)) submit();
        }, 0);
        return;
      }
      // Any other modifier combo: ignore (don't preventDefault — let it pass).
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const upper = e.key.toUpperCase();

      // PENDING MODE: typing a quantity for some item
      if (pending) {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          if (pending.qtyStr.length < 3) {
            setPending({ ...pending, qtyStr: pending.qtyStr + e.key });
          }
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          setPending({ ...pending, qtyStr: pending.qtyStr.slice(0, -1) });
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPending(null);
          return;
        }
        if (e.key === 'Enter') {
          // Commit qty and exit pending. Does NOT save the bill — Ctrl+Enter
          // is the only save trigger. Lets cashier review the bill panel
          // before committing.
          e.preventDefault();
          commitPending(pending);
          setPending(null);
          return;
        }
        // Letter — commit current pending, then start new pending for the
        // new item (or set payment mode for C/U). Anything unrecognized
        // is ignored so accidental letters don't drop the in-progress qty.
        if (/^[A-Z]$/.test(upper)) {
          e.preventDefault();
          if (upper === 'C' || upper === 'U') {
            commitPending(pending);
            setPending(null);
            setPaymentMode(upper === 'C' ? 'cash' : 'upi');
            return;
          }
          const item = itemByKey(upper);
          if (item) {
            commitPending(pending);
            setPending({ itemId: item.itemId, qtyStr: '' });
          }
          return;
        }
        return;
      }

      // IDLE MODE — plain Enter is intentionally a no-op so a stray keystroke
      // can't submit a bill. Ctrl+Enter is the only save trigger.
      if (e.key === 'Escape') {
        e.preventDefault();
        clearBill();
        return;
      }
      if (/^[A-Z]$/.test(upper)) {
        e.preventDefault();
        if (upper === 'C') {
          setPaymentMode('cash');
          return;
        }
        if (upper === 'U') {
          setPaymentMode('upi');
          return;
        }
        const item = itemByKey(upper);
        if (item) setPending({ itemId: item.itemId, qtyStr: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSummary, voidTarget, pending, total, busy, extras, thaliQty, extraQty]);

  // Pretty-print the pending state for the banner.
  const pendingLabel = useMemo(() => {
    if (!pending) return null;
    let name = 'THALI';
    let key = 'T';
    if (pending.itemId !== 'thali') {
      const ex = extras.find((e) => e.id === pending.itemId);
      if (ex) {
        name = ex.name.toUpperCase();
        key = (ex.shortcutKey ?? '').toUpperCase() || '?';
      }
    }
    return { name, key };
  }, [pending, extras]);

  const itemCards: Array<{
    itemId: string;
    name: string;
    unitPrice: number;
    shortcutKey: string;
    qty: number;
  }> = [
    {
      itemId: 'thali',
      name: 'Thali',
      unitPrice: pricePerPlate,
      shortcutKey: 'T',
      qty: thaliQty,
    },
    ...extras.map((x) => ({
      itemId: x.id,
      name: x.name,
      unitPrice: x.unitPrice,
      shortcutKey: (x.shortcutKey ?? '').toUpperCase(),
      qty: extraQty[x.id] ?? 0,
    })),
  ];

  return (
    <div className="h-full flex flex-col">
      {testMode && (
        <div className="bg-amber-500 text-white text-center py-2 text-sm font-semibold tracking-wide">
          🧪 TEST MODE — bills are NOT saved or synced. Printer test only.
        </div>
      )}
      {pending && pendingLabel && (
        <div className="bg-brand-600 text-white px-4 py-2 text-sm flex items-center gap-3">
          <kbd className="px-2 py-0.5 rounded bg-white/20 font-mono font-bold">
            {pendingLabel.key}
          </kbd>
          <span className="font-medium">Typing qty for</span>
          <span className="font-bold">{pendingLabel.name}:</span>
          <span className="font-mono text-lg tabular-nums">
            {pending.qtyStr || '_'}
          </span>
          <span className="ml-auto text-xs opacity-80">
            <kbd className="px-1.5 py-0.5 rounded bg-white/20 font-mono">Enter</kbd> commit ·{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-white/20 font-mono">Ctrl+Enter</kbd> save ·{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-white/20 font-mono">Esc</kbd> cancel
          </span>
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        {/* LEFT: item cards + bills list */}
        <div className="flex-1 p-6 bg-white border-r overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-gray-800">Items</h2>
            <div className="flex items-center gap-3">
              <div className="text-xs text-gray-500 hidden xl:block">
                Press the{' '}
                <kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">letter</kbd>{' '}
                then qty digits, then{' '}
                <kbd className="px-1.5 py-0.5 rounded border bg-white text-xs font-mono">Ctrl+Enter</kbd>{' '}
                to save
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

          <div className="grid grid-cols-3 gap-3">
            {itemCards.map((c) => {
              const isPending = pending?.itemId === c.itemId;
              const hasQty = c.qty > 0;
              const shortcutAvail = !!c.shortcutKey && !RESERVED_KEYS.has(c.shortcutKey)
                || c.shortcutKey === 'T';
              return (
                <button
                  key={c.itemId}
                  onClick={() => {
                    // Tap to start typing a qty for this item.
                    if (pending) commitPending(pending);
                    setPending({ itemId: c.itemId, qtyStr: '' });
                  }}
                  className={`relative text-left rounded-xl border-2 p-3 transition-all shadow-sm ${
                    isPending
                      ? 'bg-brand-50 border-brand-500 ring-2 ring-brand-300'
                      : hasQty
                      ? 'bg-orange-50 border-orange-300'
                      : 'bg-white border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <div className="absolute top-2 right-2">
                    {shortcutAvail && c.shortcutKey ? (
                      <kbd
                        className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                          isPending
                            ? 'bg-brand-600 text-white'
                            : 'bg-gray-100 border border-gray-300 text-gray-700'
                        }`}
                      >
                        {c.shortcutKey}
                      </kbd>
                    ) : (
                      <span className="text-[10px] text-gray-400">no key</span>
                    )}
                  </div>
                  <div className="font-semibold text-gray-800 truncate pr-10">{c.name}</div>
                  <div className="text-xs text-gray-500 tabular-nums mt-0.5">₹{c.unitPrice}</div>
                  <div className="mt-2 flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setItemQty(c.itemId, Math.max(0, c.qty - 1));
                      }}
                      disabled={c.qty === 0}
                      className="w-7 h-7 rounded-full bg-gray-200 hover:bg-gray-300 disabled:opacity-40 text-sm font-bold"
                    >
                      −
                    </button>
                    <span className="w-8 text-center tabular-nums font-bold text-lg">{c.qty}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setItemQty(c.itemId, c.qty + 1);
                      }}
                      className="w-7 h-7 rounded-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold"
                    >
                      +
                    </button>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Today's bills, newest first */}
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

        {/* RIGHT: today's stats + bill breakdown + payment + actions */}
        <div className="w-[420px] flex flex-col p-6 bg-gradient-to-b from-gray-50 to-white">
          {/* Today's running stats */}
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

          {/* Current bill breakdown */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-3 flex-1 overflow-auto min-h-0">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">
              Current bill ({totalQty} item{totalQty === 1 ? '' : 's'})
            </div>
            {billLines.length === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">
                No items yet. Press <kbd className="px-1.5 py-0.5 rounded border bg-gray-50 font-mono">T</kbd> + qty
                {extras.length > 0 && ', or any item-letter,'} then{' '}
                <kbd className="px-1.5 py-0.5 rounded border bg-gray-50 font-mono">Ctrl+Enter</kbd>{' '}
                to save.
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {billLines.map((l, i) => (
                  <div key={l.itemId} className="flex items-baseline gap-2 py-1.5 text-sm">
                    <span className="text-gray-400 tabular-nums w-5">{i + 1}.</span>
                    <span className="font-semibold flex-1 truncate">{l.name}</span>
                    <span className="text-gray-500 tabular-nums">
                      {l.qty}×₹{l.unitPrice}
                    </span>
                    <span className="font-bold tabular-nums w-16 text-right">
                      ₹{l.lineTotal}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {billLines.length > 0 && (
              <div className="mt-3 pt-3 border-t-2 border-gray-300">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold uppercase text-gray-700">Total</span>
                  <span className="text-3xl font-bold text-brand-700 tabular-nums">₹{total}</span>
                </div>
              </div>
            )}
          </div>

          <div className="mb-3">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Payment Mode</div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setPaymentMode('cash')}
                className={`py-3 rounded-xl border-2 font-semibold transition relative ${
                  paymentMode === 'cash'
                    ? 'bg-green-500 text-white border-green-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                }`}
              >
                💵 Cash
                <kbd className="absolute top-1 right-2 text-[10px] font-mono opacity-60">C</kbd>
              </button>
              <button
                onClick={() => setPaymentMode('upi')}
                className={`py-3 rounded-xl border-2 font-semibold transition relative ${
                  paymentMode === 'upi'
                    ? 'bg-blue-500 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                }`}
              >
                📱 UPI
                <kbd className="absolute top-1 right-2 text-[10px] font-mono opacity-60">U</kbd>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={clearBill}
              disabled={billLines.length === 0}
              className="col-span-1 py-3 rounded-xl border-2 border-gray-300 hover:bg-gray-100 text-sm font-semibold disabled:opacity-40"
              title="Esc"
            >
              Clear
            </button>
            <button
              onClick={submit}
              disabled={busy || total <= 0 || pricePerPlate <= 0}
              className="col-span-2 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 active:bg-brand-700 disabled:opacity-50 text-white text-base font-bold shadow-lg"
            >
              {busy ? 'Printing…' : `Save & Print · ₹${total}`}
            </button>
          </div>

          {lastBill && !lastBill.printError && (
            <div className="mt-3 p-3 rounded-lg bg-green-50 border border-green-300 text-green-800 text-sm text-center">
              ✓ Token #{lastBill.tokenNo} printed — ₹{lastBill.total} ({lastBill.paymentMode})
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
