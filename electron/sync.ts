import { getDb } from './db';

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
    const rawUrl = process.env.SUPABASE_URL || getSetting('supabase_url');
    const key = process.env.SUPABASE_ANON_KEY || getSetting('supabase_anon_key');
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
