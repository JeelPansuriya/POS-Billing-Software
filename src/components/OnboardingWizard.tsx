import { useEffect, useState } from 'react';

type Props = {
  onDone: () => void;
};

export default function OnboardingWizard({ onDone }: Props) {
  const [restaurantName, setRestaurantName] = useState('');
  const [printerName, setPrinterName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const name = (await window.api.settings.get('restaurant_name')) ?? '';
      const printer = (await window.api.settings.get('printer_name')) ?? '';
      setRestaurantName(name);
      setPrinterName(printer);
    })();
  }, []);

  const save = async () => {
    setError('');
    const name = restaurantName.trim();
    if (!name) return setError('Restaurant name is required.');
    setSaving(true);
    try {
      await window.api.settings.set('restaurant_name', name);
      if (printerName.trim()) {
        await window.api.settings.set('printer_name', printerName.trim());
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
        <div className="mb-4">
          <h2 className="text-2xl font-bold text-gray-800">Welcome 👋</h2>
          <p className="text-sm text-gray-500 mt-1">
            Set the basics now. After this, open the <strong>Menu</strong> tab to add the items
            you sell (Thali, Half Thali, Parcel, Water, Sweets…) along with their lunch and
            dinner prices. Everything else lives in Settings.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Restaurant Name
            </label>
            <input
              autoFocus
              value={restaurantName}
              onChange={(e) => setRestaurantName(e.target.value)}
              placeholder="e.g. Jay Girr Kathiyawadi"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Thermal Printer Name <span className="normal-case text-gray-400">(optional)</span>
            </label>
            <input
              value={printerName}
              onChange={(e) => setPrinterName(e.target.value)}
              placeholder='e.g. "POS-80"'
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
            <p className="text-xs text-gray-400 mt-1">
              Leave blank to use the system default printer. You can set this later in Settings.
            </p>
          </div>

          {error && (
            <div className="p-2 rounded bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDone}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Skip for now
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="px-5 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save & open Menu'}
          </button>
        </div>
      </div>
    </div>
  );
}
