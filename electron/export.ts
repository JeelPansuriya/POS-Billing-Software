import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, localISODate } from './db';

type BillRow = {
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
};

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
    // ignore
  }
}

export function getExportDir(): string {
  const configured = getSetting('export_dir');
  if (configured && configured.trim()) return configured.trim();
  return path.join(app.getPath('userData'), 'exports');
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function billsForDay(day: string): BillRow[] {
  return getDb()
    .prepare(
      `SELECT id, token_no, plates, meal_type, price_per_plate, total, payment_mode,
              created_at, voided_at, void_reason, sync_status
         FROM bills
        WHERE date(created_at, 'localtime') = ?
        ORDER BY token_no ASC`
    )
    .all(day) as BillRow[];
}

export function exportDay(
  day: string = localISODate(),
  dirOverride?: string
): { ok: boolean; path?: string; rows: number; error?: string } {
  try {
    const dir = (dirOverride && dirOverride.trim()) || getExportDir();
    ensureDir(dir);

    const rows = billsForDay(day);
    const header = [
      'token_no',
      'created_at',
      'meal_type',
      'plates',
      'price_per_plate',
      'total',
      'payment_mode',
      'voided_at',
      'void_reason',
      'id',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.token_no,
          r.created_at,
          r.meal_type,
          r.plates,
          r.price_per_plate,
          r.total,
          r.payment_mode,
          r.voided_at ?? '',
          r.void_reason ?? '',
          r.id,
        ]
          .map(csvCell)
          .join(',')
      );
    }

    const filename = `bills-${day}.csv`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, lines.join('\r\n') + '\r\n', 'utf8');

    setSetting('last_local_export_at', new Date().toISOString());
    setSetting('last_local_export_path', fullPath);

    return { ok: true, path: fullPath, rows: rows.length };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    setSetting('last_local_export_error', msg);
    return { ok: false, rows: 0, error: msg };
  }
}

export function openExportFolder(): { ok: boolean; path: string } {
  const dir = getExportDir();
  ensureDir(dir);
  shell.openPath(dir).catch(() => {});
  return { ok: true, path: dir };
}

/**
 * Auto-export yesterday's bills once per calendar day. We export *yesterday*
 * (not today) because a day's records aren't final until the day rolls over.
 * Runs from main.ts on the same minute timer as the cloud sync.
 */
export async function maybeRunDailyExport(): Promise<void> {
  const lastIso = getSetting('last_local_export_at');
  const today = localISODate();

  if (lastIso) {
    const lastDay = localISODate(new Date(lastIso));
    if (lastDay === today) return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const day = localISODate(yesterday);
  const res = exportDay(day);
  if (!res.ok) {
    console.error('[export] daily auto-export failed:', res.error);
  } else {
    console.log(`[export] auto-exported ${res.rows} bill(s) for ${day} → ${res.path}`);
  }
}
