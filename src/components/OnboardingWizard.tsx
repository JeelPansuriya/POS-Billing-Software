import { useEffect, useState } from 'react';

type Props = {
  onDone: () => void;
};

export default function OnboardingWizard({ onDone }: Props) {
  const [restaurantName, setRestaurantName] = useState('');
  const [lunchPrice, setLunchPrice] = useState<string>('');
  const [dinnerPrice, setDinnerPrice] = useState<string>('');
  const [printerName, setPrinterName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const name = (await window.api.settings.get('restaurant_name')) ?? '';
      const printer = (await window.api.settings.get('printer_name')) ?? '';
      const p = await window.api.prices.get();
      setRestaurantName(name);
      setPrinterName(printer);
      setLunchPrice(p.lunch > 0 ? String(p.lunch) : '');
      setDinnerPrice(p.dinner > 0 ? String(p.dinner) : '');
    })();
  }, []);

  const save = async () => {
    setError('');
    const name = restaurantName.trim();
    const lunch = Number(lunchPrice);
    const dinner = Number(dinnerPrice);
    if (!name) return setError('Restaurant name is required.');
    if (!Number.isFinite(lunch) || lunch <= 0) return setError('Enter a valid lunch price.');
    if (!Number.isFinite(dinner) || dinner <= 0) return setError('Enter a valid dinner price.');
    setSaving(true);
    try {
      await window.api.settings.set('restaurant_name', name);
      if (printerName.trim()) {
        await window.api.settings.set('printer_name', printerName.trim());
      }
      await window.api.prices.set('lunch', Math.round(lunch));
      await window.api.prices.set('dinner', Math.round(dinner));
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
            Let's set up the basics so you can start billing. You can change all of this later
            from Settings.
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
              placeholder="e.g. Girr Kathiyawadi"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                Lunch Price (₹)
              </label>
              <input
                type="number"
                inputMode="numeric"
                value={lunchPrice}
                onChange={(e) => setLunchPrice(e.target.value)}
                placeholder="e.g. 120"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                Dinner Price (₹)
              </label>
              <input
                type="number"
                inputMode="numeric"
                value={dinnerPrice}
                onChange={(e) => setDinnerPrice(e.target.value)}
                placeholder="e.g. 150"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
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
            {saving ? 'Saving…' : 'Save & Start Billing'}
          </button>
        </div>
      </div>
    </div>
  );
}
