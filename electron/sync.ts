import { getDb } from './db';
import { BUILT_IN_SUPABASE_URL, BUILT_IN_SUPABASE_ANON_KEY } from './config';

function isPlaceholder(v: string | null | undefined): boolean {
  if (!v) return true;
  return v.includes('YOUR-PROJECT-REF') || v.includes('PASTE_YOUR_ANON');
}

let syncing = false;

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

/**
 * Sync local pending bills to Supabase via direct PostgREST upsert.
 *
 * We use the REST endpoint instead of @supabase/supabase-js because the
 * supabase-js client eagerly initializes a Realtime client that requires a
 * native `WebSocket` constructor — Electron 32 ships Node 20 which doesn't
 * expose one. A plain fetch covers our only use case (idempotent upsert).
 */
export async function syncPendingBills(): Promise<{
  ok: boolean;
  synced: number;
  failed: number;
  reason?: string;
}> {
  if (syncing) return { ok: true, synced: 0, failed: 0, reason: 'already-running' };
  syncing = true;
  try {
    const builtInUrl = isPlaceholder(BUILT_IN_SUPABASE_URL) ? null : BUILT_IN_SUPABASE_URL;
    const builtInKey = isPlaceholder(BUILT_IN_SUPABASE_ANON_KEY)
      ? null
      : BUILT_IN_SUPABASE_ANON_KEY;
    const rawUrl = process.env.SUPABASE_URL || getSetting('supabase_url') || builtInUrl;
    const key = process.env.SUPABASE_ANON_KEY || getSetting('supabase_anon_key') || builtInKey;
    if (!rawUrl || !key) {
      return { ok: false, synced: 0, failed: 0, reason: 'supabase-not-configured' };
    }
    // Normalize whatever the user pasted into the project root URL.
    // Accepts:  https://xxx.supabase.co
    //           https://xxx.supabase.co/
    //           https://xxx.supabase.co/rest/v1
    //           https://xxx.supabase.co/rest/v1/
    const baseUrl = rawUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/rest\/v1$/i, '');

    const pending = getDb()
      .prepare(
        "SELECT * FROM bills WHERE sync_status != 'synced' ORDER BY created_at ASC LIMIT 200"
      )
      .all() as Array<{
      id: string;
      token_no: number;
      plates: number;
      meal_type: string;
      price_per_plate: number;
      total: number;
      payment_mode: string;
      created_at: string;
      voided_at: string | null;
      void_reason: string | null;
      sync_status: string;
    }>;

    if (pending.length === 0) return { ok: true, synced: 0, failed: 0 };

    const rows = pending.map((b) => ({
      id: b.id,
      token_no: b.token_no,
      plates: b.plates,
      meal_type: b.meal_type,
      price_per_plate: b.price_per_plate,
      total: b.total,
      payment_mode: b.payment_mode,
      created_at: b.created_at,
      voided_at: b.voided_at,
      void_reason: b.void_reason,
    }));

    const res = await fetch(`${baseUrl}/rest/v1/bills`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // resolution=ignore-duplicates → INSERT … ON CONFLICT DO NOTHING.
        // We deliberately don't UPDATE existing rows: that would require an
        // UPDATE policy on the table, which we don't grant to anon for safety.
        // Bills are append-only on the client too, so duplicates can only come
        // from retried network requests — silently skipping them is correct.
        // return=minimal → don't echo rows back, saves bandwidth.
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Supabase upsert error:', res.status, errText);
      const stmt = getDb().prepare("UPDATE bills SET sync_status = 'failed' WHERE id = ?");
      for (const b of pending) stmt.run(b.id);
      return {
        ok: false,
        synced: 0,
        failed: pending.length,
        reason: `${res.status} ${errText.slice(0, 200)}`,
      };
    }

    // Push the line items for every bill we just synced. We do this AFTER
    // the bills upsert because bill_items has a FK to bills(id) — items
    // can only land if the parent row is already there. ignore-duplicates
    // means re-running on already-pushed items is a no-op, so retries +
    // re-pended bills are idempotent.
    const billIds = pending.map((b) => b.id);
    const itemsPlaceholders = billIds.map(() => '?').join(',');
    const items = getDb()
      .prepare(
        `SELECT id, bill_id, catalog_id, name, qty, unit_price, plate_weight, total, sort_order
           FROM bill_items
          WHERE bill_id IN (${itemsPlaceholders})`
      )
      .all(...billIds) as Array<{
      id: string;
      bill_id: string;
      catalog_id: string | null;
      name: string;
      qty: number;
      unit_price: number;
      plate_weight: number;
      total: number;
      sort_order: number;
    }>;

    if (items.length > 0) {
      const itemsRes = await fetch(`${baseUrl}/rest/v1/bill_items`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify(items),
      });
      if (!itemsRes.ok) {
        const t = await itemsRes.text().catch(() => '');
        // 404 / "relation does not exist" = the user hasn't created the
        // bill_items table on Supabase yet. Don't mark bills as failed,
        // since the parent rows landed correctly — just log and continue.
        // Once the table exists, the next sync push will catch up via
        // the re-pend mechanism in db.ts.
        const tableMissing =
          itemsRes.status === 404 || /relation .* does not exist/i.test(t);
        if (!tableMissing) {
          console.error('Supabase bill_items upsert error:', itemsRes.status, t);
          const stmt = getDb().prepare("UPDATE bills SET sync_status = 'failed' WHERE id = ?");
          for (const b of pending) stmt.run(b.id);
          return {
            ok: false,
            synced: 0,
            failed: pending.length,
            reason: `bill_items: ${itemsRes.status} ${t.slice(0, 200)}`,
          };
        }
        console.warn(
          'bill_items table missing on Supabase — bills synced but line items skipped'
        );
      }
    }

    // For bills that have been voided locally and were already in the cloud,
    // the ignore-duplicates upsert above is a no-op. Call the void_bill RPC
    // (SECURITY DEFINER, granted to anon) to mark them voided in the cloud.
    const voided = pending.filter((b) => b.voided_at);
    for (const b of voided) {
      const r = await fetch(`${baseUrl}/rest/v1/rpc/void_bill`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_id: b.id, p_reason: b.void_reason ?? '' }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.error('Void RPC failed for', b.id, r.status, t);
        // Leave this bill as pending so next sync retries.
        continue;
      }
    }

    const stmt = getDb().prepare("UPDATE bills SET sync_status = 'synced' WHERE id = ?");
    for (const b of pending) stmt.run(b.id);
    setSetting('last_sync_at', new Date().toISOString());
    setSetting('last_sync_error', '');
    return { ok: true, synced: pending.length, failed: 0 };
  } catch (err: any) {
    console.error('Sync failed:', err);
    setSetting('last_sync_error', err?.message ?? String(err));
    return { ok: false, synced: 0, failed: 0, reason: err?.message ?? String(err) };
  } finally {
    syncing = false;
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

/**
 * Parse the schedule setting ("HH:MM,HH:MM,…") and decide if any of those
 * times has passed in the *current calendar day* without a successful sync
 * happening since. Runs every minute from main.ts.
 */
export async function maybeRunScheduledSync(): Promise<void> {
  const schedule = getSetting('backup_schedule') ?? '';
  if (!schedule.trim()) return;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const lastSyncIso = getSetting('last_sync_at');
  const lastSync = lastSyncIso ? new Date(lastSyncIso) : null;

  // Find all schedule slots that are "in the past" for today.
  const slots = schedule
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => {
      const [h, m] = s.split(':').map(Number);
      const d = new Date(todayStart);
      d.setHours(h, m, 0, 0);
      return d;
    })
    .filter((d) => d.getTime() <= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  if (slots.length === 0) return;

  // Most recent slot that should have been synced by now.
  const mostRecentSlot = slots[slots.length - 1];

  // If we haven't synced since that slot, run now.
  if (!lastSync || lastSync.getTime() < mostRecentSlot.getTime()) {
    console.log(
      `[sync] scheduled run — slot ${mostRecentSlot.toLocaleTimeString()}, last sync: ${
        lastSync?.toISOString() ?? 'never'
      }`
    );
    await syncPendingBills();
  }
}

export function resetClient() {
  // No-op now (kept for API compatibility — old code may import it).
}

// ----------------------------------------------------------------------
// Admin-only cloud operations (compare + restore). These read the entire
// cloud bills + bill_items tables, so they're paginated under the hood
// and bounded for very large histories. Each helper resolves the same
// Supabase config block as syncPendingBills.
// ----------------------------------------------------------------------

function resolveCloud(): { baseUrl: string; key: string } | null {
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

async function fetchAll(
  baseUrl: string,
  apiKey: string,
  table: string,
  select: string
): Promise<any[]> {
  // PostgREST caps at 1000 per request by default. Walk through pages.
  const out: any[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const res = await fetch(
      `${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id.asc`,
      {
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Range: `${from}-${from + pageSize - 1}`,
          'Range-Unit': 'items',
          Prefer: 'count=exact',
        },
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${table} fetch failed: ${res.status} ${t.slice(0, 200)}`);
    }
    const page = (await res.json()) as any[];
    out.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export type CloudDiffSummary = {
  ok: true;
  localBills: number;
  cloudBills: number;
  onlyLocalBills: string[];
  onlyCloudBills: string[];
  mismatchedBills: Array<{ id: string; field: string; local: any; cloud: any }>;
  localItems: number;
  cloudItems: number;
  onlyLocalItems: number;
  onlyCloudItems: number;
};

export async function computeCloudDiff(): Promise<
  CloudDiffSummary | { ok: false; reason: string }
> {
  const cfg = resolveCloud();
  if (!cfg) return { ok: false, reason: 'supabase-not-configured' };
  try {
    const [cloudBills, cloudItems] = await Promise.all([
      fetchAll(
        cfg.baseUrl,
        cfg.key,
        'bills',
        'id,token_no,plates,meal_type,total,payment_mode,created_at,voided_at,void_reason'
      ),
      fetchAll(cfg.baseUrl, cfg.key, 'bill_items', 'id,bill_id'),
    ]);
    const localBills = getDb()
      .prepare(
        'SELECT id, token_no, plates, meal_type, total, payment_mode, created_at, voided_at, void_reason FROM bills'
      )
      .all() as any[];
    const localItems = getDb()
      .prepare('SELECT id, bill_id FROM bill_items')
      .all() as Array<{ id: string; bill_id: string }>;

    const localBillIds = new Set(localBills.map((b: any) => b.id));
    const cloudBillIds = new Set(cloudBills.map((b: any) => b.id));
    const onlyLocalBills = localBills
      .map((b: any) => b.id)
      .filter((id: string) => !cloudBillIds.has(id));
    const onlyCloudBills = cloudBills
      .map((b: any) => b.id)
      .filter((id: string) => !localBillIds.has(id));

    // For bills present in both, compare a few load-bearing fields.
    const cloudById = new Map<string, any>(cloudBills.map((b: any) => [b.id, b]));
    const mismatchedBills: CloudDiffSummary['mismatchedBills'] = [];
    for (const lb of localBills) {
      const cb = cloudById.get(lb.id);
      if (!cb) continue;
      const fields = ['token_no', 'plates', 'meal_type', 'total', 'payment_mode', 'voided_at'];
      for (const f of fields) {
        // Loose compare so null vs undefined doesn't trip us.
        if ((lb[f] ?? null) !== (cb[f] ?? null)) {
          mismatchedBills.push({ id: lb.id, field: f, local: lb[f], cloud: cb[f] });
          break; // one mismatch per bill is enough to flag
        }
      }
    }

    const localItemIds = new Set(localItems.map((i) => i.id));
    const cloudItemIds = new Set(cloudItems.map((i: any) => i.id));
    let onlyLocalItems = 0;
    let onlyCloudItems = 0;
    for (const id of localItemIds) if (!cloudItemIds.has(id)) onlyLocalItems++;
    for (const id of cloudItemIds) if (!localItemIds.has(id)) onlyCloudItems++;

    return {
      ok: true,
      localBills: localBills.length,
      cloudBills: cloudBills.length,
      onlyLocalBills,
      onlyCloudBills,
      mismatchedBills,
      localItems: localItems.length,
      cloudItems: cloudItems.length,
      onlyLocalItems,
      onlyCloudItems,
    };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

// Normalize whatever shape Supabase returns for created_at / voided_at into
// the SQLite space-format UTC string we use everywhere locally. The lexicographic
// WHERE created_at >= ? compares in analytics (and elsewhere) only line up
// when stored values share the canonical "YYYY-MM-DD HH:MM:SS" shape.
function normalizeStoredDate(s: string | null): string | null {
  if (!s) return s;
  // Already in canonical space format if it has a space and no 'T'.
  if (!s.includes('T')) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s; // fallback — leave alone
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export type CloudRestoreResult =
  | { ok: true; insertedBills: number; insertedItems: number; deletedBills: number; deletedItems: number }
  | { ok: false; reason: string };

/**
 * Replace local bills + bill_items with the cloud snapshot. Caller controls
 * whether to push pending local bills first (safe mode) or skip that step
 * (force mode — local-only bills are destroyed). Wrapped in a single
 * transaction so a partial run can't leave the DB in a torn state.
 */
export async function restoreFromCloud(
  options: { pushPendingFirst: boolean }
): Promise<CloudRestoreResult> {
  const cfg = resolveCloud();
  if (!cfg) return { ok: false, reason: 'supabase-not-configured' };
  if (options.pushPendingFirst) {
    const pushRes = await syncPendingBills();
    if (!pushRes.ok) {
      return { ok: false, reason: `push-first failed: ${pushRes.reason ?? 'unknown'}` };
    }
  }
  try {
    const [cloudBills, cloudItems] = await Promise.all([
      fetchAll(
        cfg.baseUrl,
        cfg.key,
        'bills',
        'id,token_no,plates,meal_type,price_per_plate,total,payment_mode,created_at,voided_at,void_reason'
      ),
      fetchAll(
        cfg.baseUrl,
        cfg.key,
        'bill_items',
        'id,bill_id,catalog_id,name,qty,unit_price,plate_weight,total,sort_order'
      ),
    ]);
    let insertedBills = 0;
    let insertedItems = 0;
    let deletedBills = 0;
    let deletedItems = 0;

    const tx = getDb().transaction(() => {
      // bill_items has FK ON DELETE CASCADE so deleting bills cleans children.
      const beforeBills = (getDb().prepare('SELECT COUNT(*) as c FROM bills').get() as { c: number }).c;
      const beforeItems = (getDb().prepare('SELECT COUNT(*) as c FROM bill_items').get() as { c: number }).c;
      getDb().prepare('DELETE FROM bills').run();
      deletedBills = beforeBills;
      deletedItems = beforeItems;

      const insBill = getDb().prepare(
        `INSERT INTO bills (id, token_no, plates, meal_type, price_per_plate, total, payment_mode, created_at, voided_at, void_reason, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`
      );
      for (const b of cloudBills) {
        insBill.run(
          b.id,
          b.token_no,
          b.plates ?? 0,
          b.meal_type,
          b.price_per_plate ?? 0,
          b.total,
          b.payment_mode,
          normalizeStoredDate(b.created_at),
          normalizeStoredDate(b.voided_at),
          b.void_reason
        );
        insertedBills++;
      }
      const insItem = getDb().prepare(
        `INSERT INTO bill_items (id, bill_id, catalog_id, name, qty, unit_price, plate_weight, total, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const it of cloudItems) {
        insItem.run(
          it.id,
          it.bill_id,
          it.catalog_id,
          it.name,
          it.qty,
          it.unit_price,
          it.plate_weight ?? 0,
          it.total,
          it.sort_order ?? 0
        );
        insertedItems++;
      }
    });
    tx();

    return { ok: true, insertedBills, insertedItems, deletedBills, deletedItems };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
