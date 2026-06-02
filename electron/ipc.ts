import type { IpcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getDb, localISODate, nextTokenNo, writeAudit } from './db';
import { printToken, printDaySummary, printTest } from './printer';
import { syncPendingBills } from './sync';
import { pushSetting, pushPrices } from './settings-sync';
import { previewTokenPdf } from './preview-pdf';
import { exportDay, openExportFolder, getExportDir } from './export';
import { dialog } from 'electron';

type DayCloseResult = {
  printed: boolean;
  printError?: string;
  sync: { ok: boolean; synced: number; failed: number; reason?: string };
};

// Tracks the currently logged-in user so audit entries can attribute to them
// without threading actor through every IPC signature. Renderer calls
// `session:set` after login and `session:clear` on logout.
let currentActor: { id: string; username: string } | null = null;

function actorFields() {
  return {
    actorUserId: currentActor?.id ?? null,
    actorUsername: currentActor?.username ?? null,
  };
}

export function registerIpcHandlers(ipcMain: IpcMain) {
  // ---- SESSION ----
  ipcMain.handle('session:set', (_e, user: { id: string; username: string } | null) => {
    currentActor = user;
    return { ok: true };
  });
  ipcMain.handle('session:clear', () => {
    if (currentActor) writeAudit({ ...actorFields(), action: 'logout' });
    currentActor = null;
    return { ok: true };
  });

  // ---- AUTH ----
  ipcMain.handle('auth:login', (_e, username: string, password: string) => {
    const row = getDb()
      .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(username) as
      | { id: string; username: string; password_hash: string; role: 'manager' | 'admin' }
      | undefined;
    if (!row) {
      writeAudit({ actorUsername: username, action: 'login_failed', details: { reason: 'unknown_user' } });
      return { ok: false, error: 'Invalid credentials' };
    }
    if (!bcrypt.compareSync(password, row.password_hash)) {
      writeAudit({
        actorUserId: row.id,
        actorUsername: row.username,
        action: 'login_failed',
        details: { reason: 'bad_password' },
      });
      return { ok: false, error: 'Invalid credentials' };
    }
    writeAudit({ actorUserId: row.id, actorUsername: row.username, action: 'login' });
    return { ok: true, user: { id: row.id, username: row.username, role: row.role } };
  });

  ipcMain.handle(
    'auth:changePassword',
    (_e, userId: string, oldPassword: string, newPassword: string) => {
      const row = getDb()
        .prepare('SELECT username, password_hash FROM users WHERE id = ?')
        .get(userId) as { username: string; password_hash: string } | undefined;
      if (!row) return { ok: false, error: 'User not found' };
      if (!bcrypt.compareSync(oldPassword, row.password_hash))
        return { ok: false, error: 'Current password is incorrect' };
      const newHash = bcrypt.hashSync(newPassword, 10);
      getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
      writeAudit({
        actorUserId: userId,
        actorUsername: row.username,
        action: 'password_change',
        entityType: 'user',
        entityId: userId,
      });
      return { ok: true };
    }
  );

  // ---- PRICES ----
  ipcMain.handle('prices:get', () => {
    const rows = getDb()
      .prepare('SELECT meal_type, price_per_plate FROM prices')
      .all() as Array<{ meal_type: 'lunch' | 'dinner'; price_per_plate: number }>;
    const out: { lunch: number; dinner: number } = { lunch: 0, dinner: 0 };
    for (const r of rows) out[r.meal_type] = r.price_per_plate;
    return out;
  });

  ipcMain.handle(
    'prices:set',
    (_e, mealType: 'lunch' | 'dinner', pricePerPlate: number) => {
      const prev = getDb()
        .prepare('SELECT price_per_plate FROM prices WHERE meal_type = ?')
        .get(mealType) as { price_per_plate: number } | undefined;
      getDb()
        .prepare(
          `INSERT INTO prices (meal_type, price_per_plate, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(meal_type) DO UPDATE SET price_per_plate=excluded.price_per_plate, updated_at=datetime('now')`
        )
        .run(mealType, pricePerPlate);
      writeAudit({
        ...actorFields(),
        action: 'price_change',
        entityType: 'price',
        entityId: mealType,
        details: { from: prev?.price_per_plate ?? null, to: pricePerPlate },
      });
      // Best-effort push to other devices. Failure tolerated — local write
      // already succeeded and the pull tick on this device will resync if
      // the cloud later disagrees.
      pushPrices().catch((e) => console.error('pushPrices after prices:set failed:', e));
      return { ok: true };
    }
  );

  // ---- BILLS ----
  ipcMain.handle(
    'bills:create',
    async (
      _e,
      payload: {
        plates: number;
        mealType: 'lunch' | 'dinner';
        paymentMode: 'cash' | 'upi';
      }
    ) => {
      const priceRow = getDb()
        .prepare('SELECT price_per_plate FROM prices WHERE meal_type = ?')
        .get(payload.mealType) as { price_per_plate: number } | undefined;
      if (!priceRow) return { ok: false, error: 'Price not configured' };

      const id = randomUUID();
      const tokenNo = nextTokenNo();
      const total = priceRow.price_per_plate * payload.plates;

      getDb()
        .prepare(
          `INSERT INTO bills (id, token_no, plates, meal_type, price_per_plate, total, payment_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          tokenNo,
          payload.plates,
          payload.mealType,
          priceRow.price_per_plate,
          total,
          payload.paymentMode
        );

      const bill = {
        id,
        tokenNo,
        plates: payload.plates,
        mealType: payload.mealType,
        pricePerPlate: priceRow.price_per_plate,
        total,
        paymentMode: payload.paymentMode,
        createdAt: new Date().toISOString(),
      };

      // Fire-and-forget print and sync
      const restaurantName =
        (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
          | { value: string }
          | undefined)?.value ?? 'Restaurant';

      // Await the print so the renderer can surface a toast on failure (and
      // offer "Reprint"). The bill itself is already committed — a print error
      // never blocks the sale.
      let printError: string | undefined;
      try {
        await printToken({ ...bill, restaurantName });
      } catch (err: any) {
        printError = err?.message ?? String(err);
        console.error('Print failed:', err);
      }
      syncPendingBills().catch((err) => console.error('Sync failed:', err));

      return { ok: true, bill, printError };
    }
  );

  // ---- VOID ----
  ipcMain.handle('bills:void', async (_e, billId: string, reason: string) => {
    const row = getDb()
      .prepare('SELECT id, voided_at FROM bills WHERE id = ?')
      .get(billId) as { id: string; voided_at: string | null } | undefined;
    if (!row) return { ok: false, error: 'Bill not found' };
    if (row.voided_at) return { ok: false, error: 'Already voided' };

    getDb()
      .prepare(
        `UPDATE bills
            SET voided_at = datetime('now'),
                void_reason = ?,
                sync_status = 'pending'
          WHERE id = ?`
      )
      .run(reason ?? '', billId);

    writeAudit({
      ...actorFields(),
      action: 'void',
      entityType: 'bill',
      entityId: billId,
      details: { reason: reason ?? '' },
    });

    // Best-effort cloud push so the void propagates. Failure is non-fatal —
    // next scheduled sync will retry.
    syncPendingBills().catch((e) => console.error('Sync after void failed:', e));

    return { ok: true };
  });

  ipcMain.handle(
    'bills:list',
    (
      _e,
      filter: {
        from?: string;
        to?: string;
        mealType?: 'lunch' | 'dinner';
        tokenNo?: number;
        limit?: number;
      } = {}
    ) => {
      const where: string[] = [];
      const params: any[] = [];
      if (filter.from) {
        where.push('created_at >= ?');
        params.push(filter.from);
      }
      if (filter.to) {
        where.push('created_at < ?');
        params.push(filter.to);
      }
      if (filter.mealType) {
        where.push('meal_type = ?');
        params.push(filter.mealType);
      }
      if (typeof filter.tokenNo === 'number' && Number.isFinite(filter.tokenNo)) {
        where.push('token_no = ?');
        params.push(filter.tokenNo);
      }
      const sql = `SELECT * FROM bills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
      params.push(filter.limit ?? 1000);
      return getDb().prepare(sql).all(...params);
    }
  );

  // ---- TODAY'S RUNNING STATS ----
  ipcMain.handle('stats:today', () => {
    const today = localISODate();

    const totals = getDb()
      .prepare(
        `SELECT COUNT(*) as bills, COALESCE(SUM(plates), 0) as plates, COALESCE(SUM(total), 0) as revenue
         FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL`
      )
      .get(today) as { bills: number; plates: number; revenue: number };

    // Token numbers never reuse — voided rows still consume their slot, so the
    // preview must match what nextTokenNo() will actually assign on save.
    const tokenCount = getDb()
      .prepare(
        `SELECT COUNT(*) as c FROM bills WHERE date(created_at, 'localtime') = ?`
      )
      .get(today) as { c: number };

    const byPay = getDb()
      .prepare(
        `SELECT payment_mode, COALESCE(SUM(total), 0) as revenue
           FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL
          GROUP BY payment_mode`
      )
      .all(today) as Array<{ payment_mode: 'cash' | 'upi'; revenue: number }>;

    const cash = byPay.find((p) => p.payment_mode === 'cash')?.revenue ?? 0;
    const upi = byPay.find((p) => p.payment_mode === 'upi')?.revenue ?? 0;

    return {
      nextTokenNo: tokenCount.c + 1,
      bills: totals.bills,
      plates: totals.plates,
      revenue: totals.revenue,
      cash,
      upi,
    };
  });

  // ---- ANALYTICS ----
  ipcMain.handle('analytics:summary', (_e, range: { from: string; to: string }) => {
    const total = getDb()
      .prepare(
        `SELECT
          COUNT(*) as bills,
          COALESCE(SUM(plates), 0) as plates,
          COALESCE(SUM(total), 0) as revenue
         FROM bills
         WHERE created_at >= ? AND created_at < ?
           AND voided_at IS NULL`
      )
      .get(range.from, range.to) as { bills: number; plates: number; revenue: number };

    const byMeal = getDb()
      .prepare(
        `SELECT meal_type, COUNT(*) as bills, COALESCE(SUM(plates), 0) as plates, COALESCE(SUM(total), 0) as revenue
         FROM bills
         WHERE created_at >= ? AND created_at < ?
           AND voided_at IS NULL
         GROUP BY meal_type`
      )
      .all(range.from, range.to);

    const byPayment = getDb()
      .prepare(
        `SELECT payment_mode, COUNT(*) as bills, COALESCE(SUM(total), 0) as revenue
         FROM bills
         WHERE created_at >= ? AND created_at < ?
           AND voided_at IS NULL
         GROUP BY payment_mode`
      )
      .all(range.from, range.to);

    const daily = getDb()
      .prepare(
        `SELECT date(created_at, 'localtime') as day,
                COALESCE(SUM(plates), 0) as plates,
                COALESCE(SUM(total), 0) as revenue
         FROM bills
         WHERE created_at >= ? AND created_at < ?
           AND voided_at IS NULL
         GROUP BY date(created_at, 'localtime') ORDER BY day`
      )
      .all(range.from, range.to);

    return { total, byMeal, byPayment, daily };
  });

  // ---- HOUR-OF-DAY ANALYTICS ----
  // Returns an array of 24 buckets (0..23) so the chart can always render a
  // full day even when some hours have zero bills.
  ipcMain.handle('analytics:hourly', (_e, range: { from: string; to: string }) => {
    const rows = getDb()
      .prepare(
        `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour,
                COUNT(*) as bills,
                COALESCE(SUM(plates), 0) as plates,
                COALESCE(SUM(total), 0) as revenue
           FROM bills
          WHERE created_at >= ? AND created_at < ?
            AND voided_at IS NULL
          GROUP BY hour
          ORDER BY hour`
      )
      .all(range.from, range.to) as Array<{
      hour: number;
      bills: number;
      plates: number;
      revenue: number;
    }>;

    const buckets = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      bills: 0,
      plates: 0,
      revenue: 0,
    }));
    for (const r of rows) {
      if (r.hour >= 0 && r.hour < 24) buckets[r.hour] = r;
    }
    return buckets;
  });

  // ---- SETTINGS ----
  ipcMain.handle('settings:get', (_e, key: string) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  });

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    const prev = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
    // Don't audit secrets verbatim — record the key + lengths only.
    const isSecret = key === 'supabase_anon_key' || key === 'supabase_url';
    writeAudit({
      ...actorFields(),
      action: 'setting_change',
      entityType: 'setting',
      entityId: key,
      details: isSecret
        ? { from_len: prev?.value?.length ?? 0, to_len: value?.length ?? 0 }
        : { from: prev?.value ?? null, to: value },
    });
    // Cross-device push (whitelist-gated inside pushSetting). Per-device keys
    // like printer_name and supabase_url are filtered out so they stay local.
    pushSetting(key, value).catch((e) => console.error('pushSetting failed:', e));
    return { ok: true };
  });

  // ---- AUDIT ----
  ipcMain.handle(
    'audit:list',
    (_e, filter: { limit?: number; action?: string } = {}) => {
      const where: string[] = [];
      const params: any[] = [];
      if (filter.action) {
        where.push('action = ?');
        params.push(filter.action);
      }
      const sql = `SELECT id, at, actor_user_id, actor_username, action, entity_type, entity_id, details
                   FROM audit_log
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY at DESC
                   LIMIT ?`;
      params.push(Math.min(filter.limit ?? 200, 1000));
      return getDb().prepare(sql).all(...params);
    }
  );

  // ---- SYNC ----
  ipcMain.handle('sync:now', async () => syncPendingBills());

  ipcMain.handle('sync:pendingCount', () => {
    const row = getDb()
      .prepare("SELECT COUNT(*) as c FROM bills WHERE sync_status != 'synced'")
      .get() as { c: number };
    return row.c;
  });

  // ---- DAY SUMMARY (Z-report) ----
  ipcMain.handle('day:summary', (_e, dayIso?: string) => {
    // dayIso is the ISO date prefix YYYY-MM-DD (local) — defaults to today.
    const day = dayIso ?? localISODate();

    const totals = getDb()
      .prepare(
        `SELECT COUNT(*) as bills, COALESCE(SUM(plates), 0) as plates, COALESCE(SUM(total), 0) as revenue,
                MIN(token_no) as first_token, MAX(token_no) as last_token
         FROM bills WHERE date(created_at) = ?`
      )
      .get(day) as {
      bills: number;
      plates: number;
      revenue: number;
      first_token: number | null;
      last_token: number | null;
    };

    const meals = getDb()
      .prepare(
        `SELECT meal_type, COALESCE(SUM(plates),0) as plates, COALESCE(SUM(total),0) as revenue
         FROM bills WHERE date(created_at) = ? GROUP BY meal_type`
      )
      .all(day) as Array<{ meal_type: 'lunch' | 'dinner'; plates: number; revenue: number }>;

    const pays = getDb()
      .prepare(
        `SELECT payment_mode, COALESCE(SUM(total),0) as revenue
         FROM bills WHERE date(created_at) = ? GROUP BY payment_mode`
      )
      .all(day) as Array<{ payment_mode: 'cash' | 'upi'; revenue: number }>;

    const summary = {
      day,
      totalBills: totals.bills,
      totalPlates: totals.plates,
      totalRevenue: totals.revenue,
      firstToken: totals.first_token,
      lastToken: totals.last_token,
      lunchPlates: meals.find((m) => m.meal_type === 'lunch')?.plates ?? 0,
      lunchRevenue: meals.find((m) => m.meal_type === 'lunch')?.revenue ?? 0,
      dinnerPlates: meals.find((m) => m.meal_type === 'dinner')?.plates ?? 0,
      dinnerRevenue: meals.find((m) => m.meal_type === 'dinner')?.revenue ?? 0,
      cashRevenue: pays.find((p) => p.payment_mode === 'cash')?.revenue ?? 0,
      upiRevenue: pays.find((p) => p.payment_mode === 'upi')?.revenue ?? 0,
    };
    return summary;
  });

  ipcMain.handle('day:print', async (_e, dayIso?: string) => {
    const day = dayIso ?? localISODate();

    const totals = getDb()
      .prepare(
        `SELECT COUNT(*) as bills, COALESCE(SUM(plates), 0) as plates, COALESCE(SUM(total), 0) as revenue,
                MIN(token_no) as first_token, MAX(token_no) as last_token
           FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL`
      )
      .get(day) as {
      bills: number;
      plates: number;
      revenue: number;
      first_token: number | null;
      last_token: number | null;
    };
    const meals = getDb()
      .prepare(
        `SELECT meal_type, COALESCE(SUM(plates),0) as plates, COALESCE(SUM(total),0) as revenue
           FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL
          GROUP BY meal_type`
      )
      .all(day) as Array<{ meal_type: 'lunch' | 'dinner'; plates: number; revenue: number }>;
    const pays = getDb()
      .prepare(
        `SELECT payment_mode, COALESCE(SUM(total),0) as revenue
           FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL
          GROUP BY payment_mode`
      )
      .all(day) as Array<{ payment_mode: 'cash' | 'upi'; revenue: number }>;

    const restaurantName =
      (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
        | { value: string }
        | undefined)?.value ?? 'Restaurant';

    // Format date as DD/MM/YYYY for the Indian audience
    const [yyyy, mm, dd] = day.split('-');
    const dayLabel = `${dd}/${mm}/${yyyy}`;

    const result: DayCloseResult = {
      printed: false,
      sync: { ok: false, synced: 0, failed: 0 },
    };

    try {
      await printDaySummary({
        restaurantName,
        dayLabel,
        totalBills: totals.bills,
        totalPlates: totals.plates,
        totalRevenue: totals.revenue,
        firstToken: totals.first_token,
        lastToken: totals.last_token,
        lunchPlates: meals.find((m) => m.meal_type === 'lunch')?.plates ?? 0,
        lunchRevenue: meals.find((m) => m.meal_type === 'lunch')?.revenue ?? 0,
        dinnerPlates: meals.find((m) => m.meal_type === 'dinner')?.plates ?? 0,
        dinnerRevenue: meals.find((m) => m.meal_type === 'dinner')?.revenue ?? 0,
        cashRevenue: pays.find((p) => p.payment_mode === 'cash')?.revenue ?? 0,
        upiRevenue: pays.find((p) => p.payment_mode === 'upi')?.revenue ?? 0,
      });
      result.printed = true;
    } catch (err: any) {
      result.printError = err?.message ?? String(err);
      console.error('Day summary print failed:', err);
    }

    // After the slip prints, force a cloud sync so end-of-day numbers reach
    // Supabase even if the next scheduled slot is hours away.
    result.sync = await syncPendingBills();

    return result;
  });

  // ---- EXPORT (daily local backup) ----
  ipcMain.handle('export:run', (_e, dayIso?: string) => {
    return exportDay(dayIso ?? localISODate());
  });

  ipcMain.handle('export:openFolder', () => openExportFolder());

  ipcMain.handle('export:getDir', () => getExportDir());

  ipcMain.handle('export:pickDir', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false };
    const dir = res.filePaths[0];
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('export_dir', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(dir);
    return { ok: true, path: dir };
  });

  // ---- CASH RECONCILIATION ----
  ipcMain.handle('cash:get', (_e, dayIso?: string) => {
    const day = dayIso ?? localISODate();
    // Always recompute system cash from bills so today's value tracks live.
    const sys = getDb()
      .prepare(
        `SELECT COALESCE(SUM(total),0) as cash
           FROM bills
          WHERE date(created_at, 'localtime') = ?
            AND voided_at IS NULL
            AND payment_mode = 'cash'`
      )
      .get(day) as { cash: number };
    const row = getDb()
      .prepare('SELECT * FROM cash_count WHERE day = ?')
      .get(day) as
      | {
          day: string;
          counted_cash: number;
          system_cash: number;
          variance: number;
          note: string | null;
          recorded_at: string;
          recorded_by_username: string | null;
        }
      | undefined;
    return {
      day,
      systemCash: sys.cash,
      counted: row
        ? {
            countedCash: row.counted_cash,
            variance: row.counted_cash - sys.cash,
            note: row.note,
            recordedAt: row.recorded_at,
            recordedBy: row.recorded_by_username,
          }
        : null,
    };
  });

  ipcMain.handle(
    'cash:set',
    (
      _e,
      payload: { day?: string; countedCash: number; note?: string }
    ) => {
      const day = payload.day ?? localISODate();
      const sys = getDb()
        .prepare(
          `SELECT COALESCE(SUM(total),0) as cash
             FROM bills
            WHERE date(created_at, 'localtime') = ?
              AND voided_at IS NULL
              AND payment_mode = 'cash'`
        )
        .get(day) as { cash: number };
      const variance = payload.countedCash - sys.cash;
      const actor = actorFields();
      getDb()
        .prepare(
          `INSERT INTO cash_count
             (day, counted_cash, system_cash, variance, note, recorded_at, recorded_by_user_id, recorded_by_username)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
           ON CONFLICT(day) DO UPDATE SET
             counted_cash = excluded.counted_cash,
             system_cash  = excluded.system_cash,
             variance     = excluded.variance,
             note         = excluded.note,
             recorded_at  = excluded.recorded_at,
             recorded_by_user_id  = excluded.recorded_by_user_id,
             recorded_by_username = excluded.recorded_by_username`
        )
        .run(
          day,
          payload.countedCash,
          sys.cash,
          variance,
          payload.note ?? null,
          actor.actorUserId,
          actor.actorUsername
        );
      writeAudit({
        ...actor,
        action: 'cash_count',
        entityType: 'cash_count',
        entityId: day,
        details: { countedCash: payload.countedCash, systemCash: sys.cash, variance },
      });
      return { ok: true, day, systemCash: sys.cash, variance };
    }
  );

  // ---- DB INTEGRITY ----
  ipcMain.handle('db:integrityCheck', () => {
    const rows = getDb().prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    const messages = rows.map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    writeAudit({
      ...actorFields(),
      action: 'integrity_check',
      details: { ok, messages },
    });
    return { ok, messages };
  });

  // ---- RESTORE (from a CSV produced by the local export) ----
  // Two-phase: dry-run preview first, then commit. Dedupes by primary key id
  // so a partially-restored set can be re-run safely. Restored rows are
  // marked sync_status='pending' so the next sync pushes them to Supabase.
  ipcMain.handle(
    'restore:fromCsv',
    async (_e, payload: { filePath?: string; commit?: boolean }) => {
      let filePath = payload.filePath;
      if (!filePath) {
        const res = await dialog.showOpenDialog({
          title: 'Choose CSV backup to restore',
          properties: ['openFile'],
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
        filePath = res.filePaths[0];
      }
      const fs = await import('node:fs/promises');
      let text: string;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (err: any) {
        return { ok: false, error: `Could not read file: ${err?.message ?? err}` };
      }

      // Minimal CSV parser — handles double-quoted fields with embedded commas
      // and "" escapes. Avoids pulling in a dep for one-shot restore use.
      const parseCsv = (src: string): string[][] => {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = '';
        let inQuotes = false;
        for (let i = 0; i < src.length; i++) {
          const c = src[i];
          if (inQuotes) {
            if (c === '"' && src[i + 1] === '"') {
              field += '"';
              i++;
            } else if (c === '"') {
              inQuotes = false;
            } else {
              field += c;
            }
          } else if (c === '"') {
            inQuotes = true;
          } else if (c === ',') {
            row.push(field);
            field = '';
          } else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
          } else {
            field += c;
          }
        }
        if (field.length > 0 || row.length > 0) {
          row.push(field);
          if (row.length > 1 || row[0] !== '') rows.push(row);
        }
        return rows;
      };

      const rows = parseCsv(text);
      if (rows.length === 0) return { ok: false, error: 'Empty CSV' };
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const idx = (n: string) => header.indexOf(n);
      const required = ['id', 'token_no', 'plates', 'meal_type', 'price_per_plate', 'total', 'payment_mode', 'created_at'];
      const missing = required.filter((c) => idx(c) < 0);
      if (missing.length > 0) {
        return { ok: false, error: `Missing columns: ${missing.join(', ')}` };
      }

      const candidates: Array<{
        id: string;
        token_no: number;
        plates: number;
        meal_type: 'lunch' | 'dinner';
        price_per_plate: number;
        total: number;
        payment_mode: 'cash' | 'upi';
        created_at: string;
        voided_at: string | null;
        void_reason: string | null;
      }> = [];
      for (let r = 1; r < rows.length; r++) {
        const cols = rows[r];
        if (cols.length < required.length) continue;
        const meal = cols[idx('meal_type')] as 'lunch' | 'dinner';
        const pay = cols[idx('payment_mode')] as 'cash' | 'upi';
        if (meal !== 'lunch' && meal !== 'dinner') continue;
        if (pay !== 'cash' && pay !== 'upi') continue;
        candidates.push({
          id: cols[idx('id')],
          token_no: Number(cols[idx('token_no')]),
          plates: Number(cols[idx('plates')]),
          meal_type: meal,
          price_per_plate: Number(cols[idx('price_per_plate')]),
          total: Number(cols[idx('total')]),
          payment_mode: pay,
          created_at: cols[idx('created_at')],
          voided_at: idx('voided_at') >= 0 ? cols[idx('voided_at')] || null : null,
          void_reason: idx('void_reason') >= 0 ? cols[idx('void_reason')] || null : null,
        });
      }

      const existing = new Set(
        (getDb().prepare('SELECT id FROM bills').all() as Array<{ id: string }>).map(
          (r) => r.id
        )
      );
      const toInsert = candidates.filter((c) => !existing.has(c.id));
      const skipped = candidates.length - toInsert.length;

      if (!payload.commit) {
        return {
          ok: true,
          preview: true,
          parsed: candidates.length,
          toInsert: toInsert.length,
          skipped,
        };
      }

      const insert = getDb().prepare(
        `INSERT INTO bills
           (id, token_no, plates, meal_type, price_per_plate, total, payment_mode,
            created_at, voided_at, void_reason, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      );
      const tx = getDb().transaction((rows: typeof toInsert) => {
        for (const b of rows) {
          insert.run(
            b.id,
            b.token_no,
            b.plates,
            b.meal_type,
            b.price_per_plate,
            b.total,
            b.payment_mode,
            b.created_at,
            b.voided_at,
            b.void_reason
          );
        }
      });
      tx(toInsert);

      writeAudit({
        ...actorFields(),
        action: 'restore',
        entityType: 'bills',
        details: { filePath, inserted: toInsert.length, skipped },
      });
      return { ok: true, preview: false, inserted: toInsert.length, skipped };
    }
  );

  // ---- PRINTER ----
  ipcMain.handle('printer:test', async () => {
    try {
      await printTest();
      writeAudit({ ...actorFields(), action: 'printer_test', details: { ok: true } });
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      writeAudit({
        ...actorFields(),
        action: 'printer_test',
        details: { ok: false, error: msg },
      });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('preview:tokenPdf', async (_e, billId?: string) => {
    return previewTokenPdf(billId);
  });

  ipcMain.handle('printer:reprint', async (_e, billId: string) => {
    const bill = getDb().prepare('SELECT * FROM bills WHERE id = ?').get(billId) as
      | {
          id: string;
          token_no: number;
          plates: number;
          meal_type: 'lunch' | 'dinner';
          price_per_plate: number;
          total: number;
          payment_mode: 'cash' | 'upi';
          created_at: string;
        }
      | undefined;
    if (!bill) return { ok: false, error: 'Bill not found' };
    const restaurantName =
      (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
        | { value: string }
        | undefined)?.value ?? 'Restaurant';
    await printToken({
      id: bill.id,
      tokenNo: bill.token_no,
      plates: bill.plates,
      mealType: bill.meal_type,
      pricePerPlate: bill.price_per_plate,
      total: bill.total,
      paymentMode: bill.payment_mode,
      createdAt: bill.created_at,
      restaurantName,
    });
    return { ok: true };
  });
}
