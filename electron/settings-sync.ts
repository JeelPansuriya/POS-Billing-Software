import { getDb } from './db';
import { BUILT_IN_SUPABASE_URL, BUILT_IN_SUPABASE_ANON_KEY } from './config';

// Keys that sync across devices. Per-device state (printer_name, supabase_url,
// last_sync_at, …) is intentionally excluded — sharing those would break each
// install's local config. Prices ride along as virtual keys price_lunch /
// price_dinner, so a single mechanism covers everything the admin can change.
const SYNCED_KEYS = [
  'restaurant_name',
  'restaurant_address',
  'restaurant_mobile',
  'restaurant_insta',
  'backup_schedule',
  // Catalog (incl. each item's lunch + dinner price and plate_weight) is the
  // single source of pricing post-refactor. The legacy price_lunch /
  // price_dinner top-level keys are no longer synced.
  'extras_catalog',
];

function isPlaceholder(v: string | null | undefined): boolean {
  if (!v) return true;
  return v.includes('YOUR-PROJECT-REF') || v.includes('PASTE_YOUR_ANON');
}

function getSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string) {
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  } catch {
    // ignore — DB might not be ready during boot
  }
}

function resolveSupabase(): { baseUrl: string; key: string } | null {
  const builtInUrl = isPlaceholder(BUILT_IN_SUPABASE_URL) ? null : BUILT_IN_SUPABASE_URL;
  const builtInKey = isPlaceholder(BUILT_IN_SUPABASE_ANON_KEY)
    ? null
    : BUILT_IN_SUPABASE_ANON_KEY;
  const rawUrl = process.env.SUPABASE_URL || getSetting('supabase_url') || builtInUrl;
  const key = process.env.SUPABASE_ANON_KEY || getSetting('supabase_anon_key') || builtInKey;
  if (!rawUrl || !key) return null;
  const baseUrl = rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { baseUrl, key };
}

/**
 * Push a single setting to Supabase app_settings. Best-effort: a missing
 * table or any non-200 is swallowed so the local write — already committed
 * before this is called — stays canonical. Other devices pick the change up
 * on their next pull tick.
 */
export async function pushSetting(key: string, value: string): Promise<void> {
  if (!SYNCED_KEYS.includes(key)) return;
  const cfg = resolveSupabase();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.baseUrl}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([{ key, value }]),
    });
    if (!res.ok && res.status !== 404) {
      const t = await res.text().catch(() => '');
      // 404 / missing-relation = table hasn't been created yet, that's OK.
      if (!/relation .* does not exist/i.test(t)) {
        console.error('Push setting failed', key, res.status, t.slice(0, 200));
      }
    }
  } catch (err) {
    console.error('Push setting threw', key, err);
  }
}

/**
 * Push current prices to Supabase as price_lunch / price_dinner. Call after
 * any successful prices:set so remote state stays current.
 */
export async function pushPrices(): Promise<void> {
  try {
    const rows = getDb()
      .prepare('SELECT meal_type, price_per_plate FROM prices')
      .all() as Array<{ meal_type: 'lunch' | 'dinner'; price_per_plate: number }>;
    for (const r of rows) {
      await pushSetting(`price_${r.meal_type}`, String(r.price_per_plate));
    }
  } catch (err) {
    console.error('pushPrices failed', err);
  }
}

/**
 * Push the entire extras catalog as one JSON-encoded app_settings row.
 * Call after any extras:upsert / extras:delete. Treating it as one atomic
 * value avoids partial-update races between devices: the receiver always
 * sees a consistent snapshot.
 */
export async function pushExtrasCatalog(): Promise<void> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, name, unit_price, lunch_price, dinner_price, plate_weight,
                active, sort_order, shortcut_key
           FROM extras_catalog ORDER BY sort_order, name`
      )
      .all() as Array<{
      id: string;
      name: string;
      unit_price: number;
      lunch_price: number;
      dinner_price: number;
      plate_weight: number;
      active: number;
      sort_order: number;
      shortcut_key: string | null;
    }>;
    await pushSetting('extras_catalog', JSON.stringify(rows));
  } catch (err) {
    console.error('pushExtrasCatalog failed', err);
  }
}

/**
 * Pull settings rows newer than `last_settings_pull_at` and apply each
 * whitelisted key locally. Dedup keeps only the latest value per key
 * (rows are append-only on the server so the latest by updated_at wins).
 * Conflict policy: last-write-wins by remote updated_at — a remote change
 * overwrites the local value of the same key.
 */
export async function pullRemoteSettings(): Promise<void> {
  const cfg = resolveSupabase();
  if (!cfg) return;
  const since = getSetting('last_settings_pull_at') ?? '1970-01-01T00:00:00Z';
  try {
    const url = `${cfg.baseUrl}/rest/v1/app_settings?select=key,value,updated_at&updated_at=gt.${encodeURIComponent(
      since
    )}&order=updated_at.asc`;
    const res = await fetch(url, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    if (!res.ok) return; // table missing / network — silent
    const rows = (await res.json()) as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    if (rows.length === 0) return;

    // Dedup: last value per key wins (rows already ascending by updated_at).
    const latest = new Map<string, string>();
    let maxAt = since;
    for (const r of rows) {
      if (r.updated_at > maxAt) maxAt = r.updated_at;
      if (!SYNCED_KEYS.includes(r.key)) continue;
      latest.set(r.key, r.value);
    }
    for (const [key, value] of latest) applyRemoteSetting(key, value);
    setSetting('last_settings_pull_at', maxAt);
  } catch (err) {
    console.error('pullRemoteSettings failed', err);
  }
}

function applyRemoteSetting(key: string, value: string) {
  if (key === 'extras_catalog') {
    // Replace-strategy: parse the snapshot, wipe local catalog, reinsert from
    // the remote rows. Bills already reference items via denormalized name +
    // unit_price snapshots, so re-keying catalog rows can't break history.
    // Falls back gracefully on missing fields from older snapshots: an old
    // PC might still be pushing pre-refactor JSON without lunch/dinner/plate.
    try {
      const incoming = JSON.parse(value) as Array<{
        id: string;
        name: string;
        unit_price: number;
        lunch_price?: number;
        dinner_price?: number;
        plate_weight?: number;
        active: number;
        sort_order: number;
        shortcut_key?: string | null;
      }>;
      const tx = getDb().transaction(() => {
        getDb().prepare('DELETE FROM extras_catalog').run();
        const ins = getDb().prepare(
          `INSERT INTO extras_catalog (id, name, unit_price, lunch_price, dinner_price, plate_weight, active, sort_order, shortcut_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of incoming) {
          ins.run(
            r.id,
            r.name,
            r.unit_price,
            r.lunch_price ?? r.unit_price,
            r.dinner_price ?? r.unit_price,
            r.plate_weight ?? 0,
            r.active ? 1 : 0,
            r.sort_order,
            r.shortcut_key ?? null
          );
        }
      });
      tx();
    } catch (err) {
      console.error('Apply remote extras_catalog failed:', err);
    }
    return;
  }
  setSetting(key, value);
}
