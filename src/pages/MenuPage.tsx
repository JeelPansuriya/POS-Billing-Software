import { useEffect, useState } from 'react';

type Extra = {
  id: string;
  name: string;
  unitPrice: number;
  active: number;
  sortOrder: number;
};

type Draft = {
  id?: string;
  name: string;
  unitPrice: string;
  active: boolean;
  sortOrder: number;
};

const emptyDraft = (sortOrder: number): Draft => ({
  name: '',
  unitPrice: '',
  active: true,
  sortOrder,
});

export default function MenuPage() {
  const [items, setItems] = useState<Extra[]>([]);
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

  const startAdd = () => {
    const nextOrder = items.length === 0 ? 0 : Math.max(...items.map((i) => i.sortOrder)) + 10;
    setDraft(emptyDraft(nextOrder));
  };

  const startEdit = (it: Extra) =>
    setDraft({
      id: it.id,
      name: it.name,
      unitPrice: String(it.unitPrice),
      active: !!it.active,
      sortOrder: it.sortOrder,
    });

  const save = async () => {
    if (!draft) return;
    const price = Number(draft.unitPrice);
    if (!draft.name.trim()) return flash('Name required', 'err');
    if (!Number.isFinite(price) || price <= 0) return flash('Price must be > 0', 'err');
    setSaving(true);
    try {
      const r = await window.api.extras.upsert({
        id: draft.id,
        name: draft.name.trim(),
        unitPrice: price,
        active: draft.active,
        sortOrder: draft.sortOrder,
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

  const remove = async (it: Extra) => {
    if (!confirm(`Delete "${it.name}"? Existing bills referencing it stay intact.`)) return;
    const r = await window.api.extras.delete(it.id);
    if (r.ok) {
      flash('Deleted');
      await load();
    } else {
      flash(r.error ?? 'Delete failed', 'err');
    }
  };

  const toggleActive = async (it: Extra) => {
    const r = await window.api.extras.upsert({
      id: it.id,
      name: it.name,
      unitPrice: it.unitPrice,
      active: !it.active,
      sortOrder: it.sortOrder,
    });
    if (r.ok) await load();
    else flash(r.error, 'err');
  };

  return (
    <div className="h-full overflow-auto p-6 bg-gray-50">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">Menu — Extras</h1>
          <div className="flex items-center gap-3">
            {msg && (
              <span
                className={`text-sm ${msgKind === 'err' ? 'text-red-700' : 'text-green-700'}`}
              >
                {msg}
              </span>
            )}
            <button
              onClick={startAdd}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold"
            >
              + Add item
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-500">
          Items here appear on the Billing page as quantity pickers alongside the Thali. Prices
          are per unit. Inactive items stay in history but disappear from the bill UI.
        </p>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-center">Active</th>
                <th className="px-4 py-3 text-right">Order</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No items yet. Click <strong>+ Add item</strong> to start.
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{it.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">₹{it.unitPrice}</td>
                  <td className="px-4 py-2 text-center">
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
                  <td className="px-4 py-2 text-right text-gray-600 tabular-nums">{it.sortOrder}</td>
                  <td className="px-4 py-2 text-right">
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
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md space-y-4">
              <h2 className="text-lg font-semibold">{draft.id ? 'Edit item' : 'Add item'}</h2>
              <div>
                <label className="block text-xs uppercase text-gray-500 mb-1">Name</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. Raas, Sweet, Roti"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-gray-500 mb-1">Unit price (₹)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={draft.unitPrice}
                  onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
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
