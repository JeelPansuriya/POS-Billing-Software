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
  | 'printer_test';

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
