import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

let db: Database.Database;

export function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function initDb() {
  const dbPath = path.join(app.getPath('userData'), 'pos.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Pre-CREATE rename: if the old bill_extras table exists, rename it to
  // bill_items BEFORE running the CREATE TABLE block below — otherwise
  // CREATE TABLE IF NOT EXISTS would create an empty bill_items alongside
  // the legacy bill_extras and the rename below would fail. Idempotent:
  // skips when bill_items already exists or bill_extras never did.
  {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const hasOld = tables.some((t) => t.name === 'bill_extras');
    const hasNew = tables.some((t) => t.name === 'bill_items');
    if (hasOld && !hasNew) {
      db.exec(`ALTER TABLE bill_extras RENAME TO bill_items`);
      const cols = db
        .prepare(`PRAGMA table_info(bill_items)`)
        .all() as Array<{ name: string }>;
      if (
        cols.some((c) => c.name === 'extra_id') &&
        !cols.some((c) => c.name === 'catalog_id')
      ) {
        db.exec(`ALTER TABLE bill_items RENAME COLUMN extra_id TO catalog_id`);
      }
      db.exec(`DROP INDEX IF EXISTS idx_bill_extras_bill`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id)`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('manager','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prices (
      meal_type TEXT PRIMARY KEY CHECK(meal_type IN ('lunch','dinner')),
      price_per_plate INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      token_no INTEGER NOT NULL,
      plates INTEGER NOT NULL,
      meal_type TEXT NOT NULL CHECK(meal_type IN ('lunch','dinner')),
      price_per_plate INTEGER NOT NULL,
      total INTEGER NOT NULL,
      payment_mode TEXT NOT NULL CHECK(payment_mode IN ('cash','upi')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      voided_at TEXT,
      void_reason TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','failed'))
    );

    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);
    CREATE INDEX IF NOT EXISTS idx_bills_sync ON bills(sync_status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_user_id TEXT,
      actor_username TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

    CREATE TABLE IF NOT EXISTS cash_count (
      day TEXT PRIMARY KEY,
      counted_cash INTEGER NOT NULL,
      system_cash INTEGER NOT NULL,
      variance INTEGER NOT NULL,
      note TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      recorded_by_user_id TEXT,
      recorded_by_username TEXT
    );

    CREATE TABLE IF NOT EXISTS extras_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      unit_price INTEGER NOT NULL DEFAULT 0,
      lunch_price INTEGER NOT NULL DEFAULT 0,
      dinner_price INTEGER NOT NULL DEFAULT 0,
      -- How many "plates" this item represents for daily-count aggregations.
      -- 1 = full thali, 0.5 = half/child, 0 = non-meal item (water, sweet, etc).
      plate_weight REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      shortcut_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-bill line items. unit_price + plate_weight are snapshotted at bill
    -- time so historical bills don't shift when the admin retunes the catalog
    -- later. Name is denormalized for the same reason.
    CREATE TABLE IF NOT EXISTS bill_items (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      catalog_id TEXT,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      plate_weight REAL NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
  `);

  // Migration: rename role 'owner' → 'admin'. SQLite can't ALTER a CHECK
  // constraint in place, so recreate the users table when we still see the
  // old value in sqlite_master. The seeded 'owner' user is renamed to 'admin'
  // while keeping its password_hash so existing installs don't get locked out.
  const usersTbl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get() as { sql: string } | undefined;
  if (usersTbl && usersTbl.sql.includes("'owner'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('manager','admin')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, username, password_hash, role, created_at)
        SELECT id,
               CASE WHEN username = 'owner' THEN 'admin' ELSE username END,
               password_hash,
               CASE WHEN role = 'owner' THEN 'admin' ELSE role END,
               created_at
          FROM users_old;
      DROP TABLE users_old;
      COMMIT;
    `);
  }

  // Migration: add shortcut_key, lunch_price, dinner_price to extras_catalog
  // on installs that pre-date them. lunch_price/dinner_price both default
  // to the existing unit_price so a single-price catalog keeps printing
  // correctly until admin edits each item.
  const extrasCols = db
    .prepare(`PRAGMA table_info(extras_catalog)`)
    .all() as Array<{ name: string }>;
  if (!extrasCols.some((c) => c.name === 'shortcut_key')) {
    db.exec(`ALTER TABLE extras_catalog ADD COLUMN shortcut_key TEXT`);
  }
  if (!extrasCols.some((c) => c.name === 'lunch_price')) {
    db.exec(`ALTER TABLE extras_catalog ADD COLUMN lunch_price INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE extras_catalog SET lunch_price = unit_price WHERE lunch_price = 0`);
  }
  if (!extrasCols.some((c) => c.name === 'dinner_price')) {
    db.exec(`ALTER TABLE extras_catalog ADD COLUMN dinner_price INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE extras_catalog SET dinner_price = unit_price WHERE dinner_price = 0`);
  }
  if (!extrasCols.some((c) => c.name === 'plate_weight')) {
    db.exec(`ALTER TABLE extras_catalog ADD COLUMN plate_weight REAL NOT NULL DEFAULT 0`);
    // Existing pre-refactor extras (sweet, roti, water…) all had no
    // plate-equivalent meaning, so 0 is the right default for them.
  }

  // Migration: snapshot plate_weight onto bill_items so historical bills
  // hold their own count. Pre-refactor rows all came in via the legacy bills
  // backfill (one Thali line per bill) — those should count as 1 plate.
  const billItemsCols = db
    .prepare(`PRAGMA table_info(bill_items)`)
    .all() as Array<{ name: string }>;
  if (!billItemsCols.some((c) => c.name === 'plate_weight')) {
    db.exec(`ALTER TABLE bill_items ADD COLUMN plate_weight REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE bill_items SET plate_weight = 1 WHERE name = 'Thali'`);
  }

  // Migration: seed a Thali catalog item from the legacy prices table on
  // first launch after the menu-driven refactor. Idempotent — guarded by a
  // setting flag, so re-running won't duplicate or revive a deleted Thali.
  const thaliSeeded = db
    .prepare("SELECT value FROM settings WHERE key = 'thali_seeded'")
    .get() as { value: string } | undefined;
  if (!thaliSeeded) {
    const legacyPrices = db
      .prepare('SELECT meal_type, price_per_plate FROM prices')
      .all() as Array<{ meal_type: 'lunch' | 'dinner'; price_per_plate: number }>;
    const lunchP = legacyPrices.find((p) => p.meal_type === 'lunch')?.price_per_plate ?? 0;
    const dinnerP = legacyPrices.find((p) => p.meal_type === 'dinner')?.price_per_plate ?? 0;
    if (lunchP > 0 || dinnerP > 0) {
      const exists = db
        .prepare('SELECT id FROM extras_catalog WHERE name = ?')
        .get('Thali') as { id: string } | undefined;
      if (!exists) {
        db.prepare(
          `INSERT INTO extras_catalog (id, name, unit_price, lunch_price, dinner_price, plate_weight, active, sort_order, shortcut_key)
           VALUES (?, 'Thali', ?, ?, ?, 1, 1, 0, 'T')`
        ).run(randomUUID(), Math.max(lunchP, dinnerP), lunchP, dinnerP);
      }
    }
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('thali_seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
  }

  // Migration: backfill bill_items with one Thali line per legacy bill so
  // every bill is uniformly line-item-driven going forward. Only touches
  // bills that have no bill_items rows yet AND have plates > 0.
  const legacyBillsToBackfill = db
    .prepare(
      `SELECT b.id, b.plates, b.price_per_plate, b.total
         FROM bills b
        WHERE b.plates > 0
          AND NOT EXISTS (SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id)`
    )
    .all() as Array<{ id: string; plates: number; price_per_plate: number; total: number }>;
  if (legacyBillsToBackfill.length > 0) {
    const ins = db.prepare(
      `INSERT INTO bill_items (id, bill_id, catalog_id, name, qty, unit_price, plate_weight, total, sort_order)
       VALUES (?, ?, NULL, 'Thali', ?, ?, 1, ?, 0)`
    );
    const tx = db.transaction(() => {
      for (const b of legacyBillsToBackfill) {
        ins.run(randomUUID(), b.id, b.plates, b.price_per_plate, b.plates * b.price_per_plate);
      }
    });
    tx();
  }

  // Migration: normalize any ISO-format created_at/voided_at on bills back
  // to the canonical SQLite space format ("YYYY-MM-DD HH:MM:SS"). A previous
  // cloud-restore stored Supabase's PostgREST output verbatim (with a 'T'
  // separator and timezone suffix), which broke lexicographic range filters
  // in analytics. Only touches rows still in the bad format.
  const normalizeIso = (s: string): string => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  };
  const isoBills = db
    .prepare("SELECT id, created_at, voided_at FROM bills WHERE created_at LIKE '%T%' OR (voided_at IS NOT NULL AND voided_at LIKE '%T%')")
    .all() as Array<{ id: string; created_at: string; voided_at: string | null }>;
  if (isoBills.length > 0) {
    const upd = db.prepare(
      'UPDATE bills SET created_at = ?, voided_at = ? WHERE id = ?'
    );
    const tx = db.transaction(() => {
      for (const r of isoBills) {
        upd.run(
          r.created_at.includes('T') ? normalizeIso(r.created_at) : r.created_at,
          r.voided_at && r.voided_at.includes('T')
            ? normalizeIso(r.voided_at)
            : r.voided_at,
          r.id
        );
      }
    });
    tx();
  }

  // Migration: one-time re-pend so every bill that has line items pushes
  // its bill_items rows on the next sync. The bills upsert is idempotent
  // (resolution=ignore-duplicates), so re-pending an already-cloud-synced
  // bill is harmless — the bills row stays as it was, and the missing
  // line items finally land. Guarded by a setting flag so this only fires
  // once.
  const extrasSyncInit = db
    .prepare("SELECT value FROM settings WHERE key = 'bill_items_sync_initialized'")
    .get() as { value: string } | undefined;
  if (!extrasSyncInit) {
    db.prepare(
      `UPDATE bills SET sync_status = 'pending'
        WHERE sync_status = 'synced'
          AND id IN (SELECT DISTINCT bill_id FROM bill_items)`
    ).run();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('bill_items_sync_initialized', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
  }

  // Migration: add void columns if missing on an older bills table.
  const billCols = db
    .prepare(`PRAGMA table_info(bills)`)
    .all() as Array<{ name: string }>;
  const hasVoidedAt = billCols.some((c) => c.name === 'voided_at');
  const hasVoidReason = billCols.some((c) => c.name === 'void_reason');
  if (!hasVoidedAt) {
    db.exec(`ALTER TABLE bills ADD COLUMN voided_at TEXT`);
  }
  if (!hasVoidReason) {
    db.exec(`ALTER TABLE bills ADD COLUMN void_reason TEXT`);
  }

  // Migration: if an older `bills` table still has the 'online' check constraint,
  // recreate it with 'upi' and map existing rows.
  const billsTbl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bills'")
    .get() as { sql: string } | undefined;
  if (billsTbl && billsTbl.sql.includes("'online'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE bills RENAME TO bills_old;
      CREATE TABLE bills (
        id TEXT PRIMARY KEY,
        token_no INTEGER NOT NULL,
        plates INTEGER NOT NULL,
        meal_type TEXT NOT NULL CHECK(meal_type IN ('lunch','dinner')),
        price_per_plate INTEGER NOT NULL,
        total INTEGER NOT NULL,
        payment_mode TEXT NOT NULL CHECK(payment_mode IN ('cash','upi')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        voided_at TEXT,
        void_reason TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','failed'))
      );
      INSERT INTO bills (id, token_no, plates, meal_type, price_per_plate, total, payment_mode, created_at, voided_at, void_reason, sync_status)
        SELECT id, token_no, plates, meal_type, price_per_plate, total,
               CASE WHEN payment_mode='online' THEN 'upi' ELSE payment_mode END,
               created_at,
               NULL, NULL,
               sync_status
          FROM bills_old;
      DROP TABLE bills_old;
      CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);
      CREATE INDEX IF NOT EXISTS idx_bills_sync ON bills(sync_status);
      COMMIT;
    `);
  }

  // Seed default users on first run
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  if (userCount.c === 0) {
    const insert = db.prepare(
      'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
    );
    insert.run(randomUUID(), 'manager', bcrypt.hashSync('manager123', 10), 'manager');
    insert.run(randomUUID(), 'admin', bcrypt.hashSync('admin123', 10), 'admin');
  }

  // Seed default prices
  const priceCount = db.prepare('SELECT COUNT(*) as c FROM prices').get() as { c: number };
  if (priceCount.c === 0) {
    const insert = db.prepare('INSERT INTO prices (meal_type, price_per_plate) VALUES (?, ?)');
    insert.run('lunch', 120);
    insert.run('dinner', 150);
  }

  // Seed default settings
  const seedSetting = (key: string, value: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  };
  seedSetting('restaurant_name', 'Jay Girr Kathiyawadi');
  seedSetting(
    'restaurant_address',
    '105, Sky Tatva, opp. Amba Ashram, College Road, Nadiad-387001'
  );
  seedSetting('restaurant_mobile', '9081810895');
  seedSetting('restaurant_insta', 'jay_girr_kathiyawadi_');
  // One-time rename for installs that still hold the original default. Custom
  // values set via Settings are left untouched.
  db.prepare(
    `UPDATE settings SET value = 'Jay Girr Kathiyawadi'
       WHERE key = 'restaurant_name' AND value = 'Girr Kathiyawadi'`
  ).run();
  // Comma-separated 24h HH:MM times — defaults: lunch close, dinner peak, end of day.
  seedSetting('backup_schedule', '15:00,20:00,23:00');
}

/**
 * Today's date as YYYY-MM-DD in the **local** timezone.
 *
 * `new Date().toISOString().slice(0,10)` would give the UTC date, which for
 * India (UTC+5:30) flips at 05:30 AM IST and causes "today" to disagree
 * between SQLite (which stores `created_at` in UTC) and the user-facing UI.
 * Pairing this with `date(created_at, 'localtime')` in queries keeps every
 * "day" boundary at local midnight.
 */
export function localISODate(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Token numbering resets to 1 at local midnight: the count is scoped to today's
// local-tz date, so the first bill after 00:00 IST gets token #1 again.
export function nextTokenNo(): number {
  const today = localISODate();
  const row = db
    .prepare("SELECT COUNT(*) as c FROM bills WHERE date(created_at, 'localtime') = ?")
    .get(today) as { c: number };
  return row.c + 1;
}

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'password_change'
  | 'price_change'
  | 'setting_change'
  | 'void'
  | 'restore'
  | 'integrity_check'
  | 'cash_count'
  | 'printer_test'
  | 'extras_change'
  | 'bill_edit'
  | 'cloud_restore'
  | 'cloud_diff';

export function writeAudit(entry: {
  actorUserId?: string | null;
  actorUsername?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  details?: unknown;
}) {
  try {
    db.prepare(
      `INSERT INTO audit_log (id, actor_user_id, actor_username, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      entry.actorUserId ?? null,
      entry.actorUsername ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.details === undefined ? null : JSON.stringify(entry.details)
    );
  } catch (err) {
    console.error('writeAudit failed:', err);
  }
}
