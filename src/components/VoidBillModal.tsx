import { useState } from 'react';

const REASON_OPTIONS = [
  'Wrong plate count',
  'Wrong payment mode',
  'Customer cancelled',
  'Bad print / reprint',
  'Other',
];

export default function VoidBillModal({
  bill,
  onClose,
  onVoided,
}: {
  bill: { id: string; token_no: number; plates: number; total: number };
  onClose: () => void;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState(REASON_OPTIONS[0]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const finalReason = reason === 'Other' ? other.trim() : reason;
    if (!finalReason) {
      setError('Please enter a reason.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await window.api.bills.void(bill.id, finalReason);
      if (!res.ok) {
        setError(res.error ?? 'Void failed.');
        return;
      }
      onVoided();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-[420px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-800">Void Token #{bill.token_no}?</h2>
          <p className="text-sm text-gray-500 mt-1">
            {bill.plates} plates · ₹{bill.total.toLocaleString()}
          </p>
        </div>
        <div className="px-6 py-5">
          <label className="block text-xs uppercase tracking-wider text-gray-500 mb-2">
            Reason
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3"
          >
            {REASON_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {reason === 'Other' && (
            <input
              type="text"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Type a reason…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              autoFocus
            />
          )}
          {error && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </p>
          )}
          <p className="mt-3 text-xs text-gray-500">
            Voiding excludes this token from totals and analytics. The token number is not reused.
          </p>
        </div>
        <div className="px-6 py-3 bg-gray-50 border-t flex justify-end gap-2 rounded-b-2xl">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-white text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {busy ? 'Voiding…' : 'Void Token'}
          </button>
        </div>
      </div>
    </div>
  );
}
