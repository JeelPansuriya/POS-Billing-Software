import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getDb } from './db';

let client: SupabaseClient | null = null;
let syncing = false;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL || getSetting('supabase_url');
  const key = process.env.SUPABASE_ANON_KEY || getSetting('supabase_anon_key');
  if (!url || !key) return null;
  client = createClient(url, key, {
    auth: { persistSession: false },
  });
  return client;
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

export async function syncPendingBills(): Promise<{
  ok: boolean;
  synced: number;
  failed: number;
  reason?: string;
}> {
  if (syncing) return { ok: true, synced: 0, failed: 0, reason: 'already-running' };
  syncing = true;
  try {
    const sb = getClient();
    if (!sb) return { ok: false, synced: 0, failed: 0, reason: 'supabase-not-configured' };

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
    }));

    const { error } = await sb.from('bills').upsert(rows, { onConflict: 'id' });
    if (error) {
      console.error('Supabase upsert error:', error);
      const stmt = getDb().prepare("UPDATE bills SET sync_status = 'failed' WHERE id = ?");
      for (const b of pending) stmt.run(b.id);
      return { ok: false, synced: 0, failed: pending.length, reason: error.message };
    }

    const stmt = getDb().prepare("UPDATE bills SET sync_status = 'synced' WHERE id = ?");
    for (const b of pending) stmt.run(b.id);
    return { ok: true, synced: pending.length, failed: 0 };
  } finally {
    syncing = false;
  }
}

export function resetClient() {
  client = null;
}
