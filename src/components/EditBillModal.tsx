import { useEffect, useMemo, useState } from 'react';

type CatalogItem = {
  id: string;
  name: string;
  lunchPrice: number;
  dinnerPrice: number;
  active: number;
};

type BillRow = {
  id: string;
  token_no: number;
  meal_type: 'lunch' | 'dinner';
  payment_mode: 'cash' | 'upi';
  total: number;
  voided_at: string | null;
  extras?: Array<{ name: string; qty: number; unitPrice: number; total: number }>;
};

type Props = {
  bill: BillRow;
  onClose: () => void;
  onSaved: () => void;
};

// Admin-only edit. Re-keys the bill's line items by current catalog state:
// the existing item rows hold names, but to mutate we need item IDs. We
// match each existing line by name against the active catalog. Items whose
// names no longer match a catalog entry render as read-only "ghost" rows
// the admin must remove explicitly before saving.
export default function EditBillModal({ bill, onClose, onSaved }: Props) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [orphans, setOrphans] = useState<
    Array<{ name: string; qty: number; unitPrice: number; total: number }>
  >([]);
  const [paymentMode, setPaymentMode] = useState<'cash' | 'upi'>(bill.payment_mode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    (async () => {
      const list = await window.api.extras.list();
      setCatalog(list);
      // Seed qty map by matching existing item names to the catalog.
      const initial: Record<string, number> = {};
      const orphansLocal: typeof orphans = [];
      const byName = new Map(list.map((c) => [c.name.toLowerCase(), c]));
      for (const ex of bill.extras ?? []) {
        const cat = byName.get(ex.name.toLowerCase());
        if (cat) initial[cat.id] = (initial[cat.id] ?? 0) + ex.qty;
        else orphansLocal.push(ex);
      }
      setQty(initial);
      setOrphans(orphansLocal);
    })();
  }, [bill.id]);

  const priceFor = (it: CatalogItem) =>
    bill.meal_type === 'lunch' ? it.lunchPrice : it.dinnerPrice;

  const lines = useMemo(
    () =>
      catalog
        .map((c) => ({
          ...c,
          unit: priceFor(c),
          q: qty[c.id] ?? 0,
        }))
        .filter((c) => c.q > 0 || true), // show all so admin can add new ones
    [catalog, qty, bill.meal_type]
  );

  const total =
    lines.reduce((s, l) => s + l.q * l.unit, 0) +
    orphans.reduce((s, o) => s + o.total, 0);

  const set = (id: string, q: number) =>
    setQty((m) => {
      const n = { ...m };
      if (q <= 0) delete n[id];
      else n[id] = q;
      return n;
    });

  const save = async () => {
    setError('');
    if (orphans.length > 0) {
      setError(
        `Remove the ${orphans.length} unmatched item(s) first — they no longer exist in the menu.`
      );
      return;
    }
    const items = Object.entries(qty)
      .filter(([, q]) => q > 0)
      .map(([itemId, q]) => ({ itemId, qty: q }));
    if (items.length === 0) {
      setError('A bill must have at least one item.');
      return;
    }
    setSaving(true);
    try {
      const r = await window.api.bills.edit({
        billId: bill.id,
        paymentMode,
        items,
      });
      if (r.ok) {
        onSaved();
        onClose();
      } else {
        setError(r.error);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-[640px] max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-800">Edit Bill #{bill.token_no}</h2>
            <p className="text-xs text-gray-500">
              Meal: {bill.meal_type.toUpperCase()} · Total ₹{bill.total} · Edits push on next sync.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-gray-100 text-gray-500 text-lg"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {orphans.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
              <div className="font-semibold text-amber-900 mb-1">Unmatched items:</div>
              <p className="text-xs text-amber-800 mb-2">
                These line items don't match any current menu entry (likely renamed/deleted).
                Remove them to save, or cancel and adjust the menu first.
              </p>
              {orphans.map((o, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-1 border-t border-amber-200 first:border-0"
                >
                  <span>
                    <span className="font-medium">{o.name}</span> × {o.qty} — ₹{o.total}
                  </span>
                  <button
                    onClick={() =>
                      setOrphans((cur) => cur.filter((_, j) => j !== i))
                    }
                    className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Items</h3>
            <div className="grid grid-cols-2 gap-2">
              {catalog.map((c) => {
                const unit = priceFor(c);
                const q = qty[c.id] ?? 0;
                const disabled = unit <= 0 || !c.active;
                return (
                  <div
                    key={c.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border ${
                      q > 0
                        ? 'bg-orange-50 border-orange-300'
                        : 'bg-white border-gray-200'
                    } ${disabled ? 'opacity-40' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{c.name}</div>
                      <div className="text-xs text-gray-500 tabular-nums">
                        {disabled ? `no ${bill.meal_type} price` : `₹${unit}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => set(c.id, Math.max(0, q - 1))}
                        disabled={q === 0 || disabled}
                        className="w-7 h-7 rounded-full bg-gray-200 hover:bg-gray-300 disabled:opacity-40 text-sm font-bold"
                      >
                        −
                      </button>
                      <span className="w-6 text-center tabular-nums font-bold">{q}</span>
                      <button
                        onClick={() => set(c.id, q + 1)}
                        disabled={disabled}
                        className="w-7 h-7 rounded-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Payment</h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setPaymentMode('cash')}
                className={`py-2.5 rounded-xl border-2 font-semibold transition ${
                  paymentMode === 'cash'
                    ? 'bg-green-500 text-white border-green-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                }`}
              >
                💵 Cash
              </button>
              <button
                onClick={() => setPaymentMode('upi')}
                className={`py-2.5 rounded-xl border-2 font-semibold transition ${
                  paymentMode === 'upi'
                    ? 'bg-blue-500 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
                }`}
              >
                📱 UPI
              </button>
            </div>
          </div>

          <div className="flex items-baseline justify-between p-3 rounded-xl bg-brand-50 border border-brand-200">
            <span className="text-sm font-semibold text-brand-700">NEW TOTAL</span>
            <span className="text-2xl font-bold text-brand-700 tabular-nums">₹{total}</span>
          </div>

          {error && (
            <div className="rounded bg-red-50 border border-red-200 text-red-700 text-sm p-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-2xl flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-white text-sm"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
