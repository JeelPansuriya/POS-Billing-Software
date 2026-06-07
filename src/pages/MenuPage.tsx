import { useEffect, useState } from 'react';

type MenuItem = {
  id: string;
  name: string;
  lunchPrice: number;
  dinnerPrice: number;
  plateWeight: number;
  active: number;
  sortOrder: number;
  shortcutKey: string | null;
};

type Draft = {
  id?: string;
  name: string;
  lunchPrice: string;
  dinnerPrice: string;
  plateWeight: string;
  active: boolean;
  sortOrder: number;
  shortcutKey: string;
};

const emptyDraft = (sortOrder: number): Draft => ({
  name: '',
  lunchPrice: '',
  dinnerPrice: '',
  // 1 is the most common case (full Thali / main item). Admin overrides for
  // half / non-meal items.
  plateWeight: '1',
  active: true,
  sortOrder,
  shortcutKey: '',
});

export default function MenuPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState<'ok' | 'err'>('ok');
  const flash = (m: string, kind: 'ok' | 'err' = 'ok') => {
    setMsg(m);
    setMsgKind(kind);
    setTimeout(() => setMsg(''), kind === 'err' ? 4000 : 2000);
  };

  const load = async () => setItems(await window.api.extras.listAll());
  useEffect(() => {
    load();
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refreshFromCloud = async () => {
    setRefreshing(true);
    try {
      const r = await window.api.sync.menuNow();
      if (r.ok) {
        flash(`✓ Synced — ${r.items} items in catalog`);
        await load();
      } else {
        flash(r.error ?? 'Sync failed', 'err');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const startAdd = () => {
    const nextOrder = items.length === 0 ? 0 : Math.max(...items.map((i) => i.sortOrder)) + 10;
    setDraft(emptyDraft(nextOrder));
  };

  const startEdit = (it: MenuItem) =>
    setDraft({
      id: it.id,
      name: it.name,
      lunchPrice: String(it.lunchPrice || ''),
      dinnerPrice: String(it.dinnerPrice || ''),
      plateWeight: String(it.plateWeight ?? 0),
      active: !!it.active,
      sortOrder: it.sortOrder,
      shortcutKey: it.shortcutKey ?? '',
    });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return flash('Name required', 'err');
    const lunchP = Number(draft.lunchPrice) || 0;
    const dinnerP = Number(draft.dinnerPrice) || 0;
    if (lunchP < 0 || dinnerP < 0) return flash('Prices must be ≥ 0', 'err');
    if (lunchP <= 0 && dinnerP <= 0) {
      return flash('Set at least one of lunch or dinner price', 'err');
    }
    const plateW = Number(draft.plateWeight);
    if (!Number.isFinite(plateW) || plateW < 0) {
      return flash('Plate count must be ≥ 0', 'err');
    }
    setSaving(true);
    try {
      const r = await window.api.extras.upsert({
        id: draft.id,
        name: draft.name.trim(),
        lunchPrice: lunchP,
        dinnerPrice: dinnerP,
        plateWeight: plateW,
        active: draft.active,
        sortOrder: draft.sortOrder,
        shortcutKey: draft.shortcutKey.trim().toUpperCase() || null,
      });
      if (r.ok) {
        flash(draft.id ? 'Updated' : 'Added');
        setDraft(null);
        await load();
      } else {
        flash(r.error, 'err');
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (it: MenuItem) => {
    if (!confirm(`Delete "${it.name}"? Existing bills referencing it stay intact.`)) return;
    const r = await window.api.extras.delete(it.id);
    if (r.ok) {
      flash('Deleted');
      await load();
    } else {
      flash(r.error ?? 'Delete failed', 'err');
    }
  };

  const toggleActive = async (it: MenuItem) => {
    const r = await window.api.extras.upsert({
      id: it.id,
      name: it.name,
      lunchPrice: it.lunchPrice,
      dinnerPrice: it.dinnerPrice,
      plateWeight: it.plateWeight,
      active: !it.active,
      sortOrder: it.sortOrder,
      shortcutKey: it.shortcutKey,
    });
    if (r.ok) await load();
    else flash(r.error, 'err');
  };

  return (
    <div className="h-full overflow-auto p-6 bg-gray-50">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">Menu</h1>
          <div className="flex items-center gap-3">
            {msg && (
              <span
                className={`text-sm ${msgKind === 'err' ? 'text-red-700' : 'text-green-700'}`}
              >
                {msg}
              </span>
            )}
            <button
              onClick={refreshFromCloud}
              disabled={refreshing}
              className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-100 text-sm font-medium disabled:opacity-50"
              title="Force-pull the menu from Supabase right now (otherwise auto-syncs every 5 min)"
            >
              {refreshing ? 'Syncing…' : '↻ Sync from cloud'}
            </button>
            <button
              onClick={startAdd}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold"
            >
              + Add item
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-500">
          Every sellable item lives here. Set per-item lunch and dinner prices — the Billing page
          uses the active session's price. <strong>Plate count</strong> is how many "plates" the
          item represents in daily totals: 1 = full Thali, 0.5 = half / child, 0 = non-meal item
          like water or sweets.
        </p>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3 text-left">Name</th>
                <th className="px-3 py-3 text-right">Lunch ₹</th>
                <th className="px-3 py-3 text-right">Dinner ₹</th>
                <th className="px-3 py-3 text-right">Plates</th>
                <th className="px-3 py-3 text-center">Key</th>
                <th className="px-3 py-3 text-center">Active</th>
                <th className="px-3 py-3 text-right">Order</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    No items yet. Click <strong>+ Add item</strong> to start.
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{it.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {it.lunchPrice > 0 ? `₹${it.lunchPrice}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {it.dinnerPrice > 0 ? `₹${it.dinnerPrice}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                    {it.plateWeight}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {it.shortcutKey ? (
                      <kbd className="px-2 py-0.5 rounded bg-gray-100 border border-gray-300 text-xs font-mono font-bold">
                        {it.shortcutKey}
                      </kbd>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleActive(it)}
                      className={`text-xs px-2 py-1 rounded ${
                        it.active
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {it.active ? 'Active' : 'Hidden'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                    {it.sortOrder}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => startEdit(it)}
                      className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 mr-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(it)}
                      className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {draft && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md space-y-4 max-h-[90vh] overflow-auto">
              <h2 className="text-lg font-semibold">{draft.id ? 'Edit item' : 'Add item'}</h2>
              <div>
                <label className="block text-xs uppercase text-gray-500 mb-1">Name</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. Thali, Child Thali, Parcel Thali, Raas, Water"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase text-gray-500 mb-1">Lunch ₹</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={draft.lunchPrice}
                    onChange={(e) => setDraft({ ...draft, lunchPrice: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-gray-500 mb-1">Dinner ₹</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={draft.dinnerPrice}
                    onChange={(e) => setDraft({ ...draft, dinnerPrice: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 -mt-2">
                Leave one blank if the item is only sold at the other session.
              </p>
              <div>
                <label className="block text-xs uppercase text-gray-500 mb-1">
                  Plate count (1 = full plate, 0.5 = half/child, 0 = non-meal)
                </label>
                <input
                  type="number"
                  step="0.1"
                  inputMode="decimal"
                  value={draft.plateWeight}
                  onChange={(e) => setDraft({ ...draft, plateWeight: e.target.value })}
                  className="w-32 px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-gray-500 mb-1">
                  Keyboard shortcut (single letter, optional)
                </label>
                <input
                  type="text"
                  maxLength={1}
                  value={draft.shortcutKey}
                  onChange={(e) =>
                    setDraft({ ...draft, shortcutKey: e.target.value.toUpperCase() })
                  }
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-center font-mono uppercase"
                  placeholder="T"
                />
                <p className="text-xs text-gray-400 mt-1">
                  C and U are reserved (Cash, UPI). On the Billing page, press this letter then a
                  number to set quantity. Leave blank to skip.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase text-gray-500 mb-1">Display order</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={draft.sortOrder}
                    onChange={(e) =>
                      setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-gray-500 mb-1">&nbsp;</label>
                  <label className="flex items-center gap-2 mt-1">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                    />
                    <span className="text-sm">Visible on Billing page</span>
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setDraft(null)}
                  className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-100 text-sm"
                >
                  Cancel
                </button>
                <button
                  disabled={saving}
                  onClick={save}
                  className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
