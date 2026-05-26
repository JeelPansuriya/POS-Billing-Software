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
      role TEXT NOT NULL CHECK(role IN ('manager','owner')),
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
      sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','failed'))
    );

    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);
    CREATE INDEX IF NOT EXISTS idx_bills_sync ON bills(sync_status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

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
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','failed'))
      );
      INSERT INTO bills (id, token_no, plates, meal_type, price_per_plate, total, payment_mode, created_at, sync_status)
        SELECT id, token_no, plates, meal_type, price_per_plate, total,
               CASE WHEN payment_mode='online' THEN 'upi' ELSE payment_mode END,
               created_at, sync_status
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
    insert.run(randomUUID(), 'owner', bcrypt.hashSync('owner123', 10), 'owner');
  }

  // Seed default prices
  const priceCount = db.prepare('SELECT COUNT(*) as c FROM prices').get() as { c: number };
  if (priceCount.c === 0) {
    const insert = db.prepare('INSERT INTO prices (meal_type, price_per_plate) VALUES (?, ?)');
    insert.run('lunch', 120);
    insert.run('dinner', 150);
  }

  // Seed default restaurant name
  const nameRow = db.prepare("SELECT value FROM settings WHERE key='restaurant_name'").get();
  if (!nameRow) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'restaurant_name',
      'Girr Kathiyawadi'
    );
  }
}

export function nextTokenNo(): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare("SELECT COUNT(*) as c FROM bills WHERE date(created_at)=?")
    .get(today) as { c: number };
  return row.c + 1;
}
