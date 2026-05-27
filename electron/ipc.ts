import type { IpcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getDb, localISODate, nextTokenNo } from './db';
import { printToken, printDaySummary } from './printer';
import { syncPendingBills } from './sync';

type DayCloseResult = {
  printed: boolean;
  printError?: string;
  sync: { ok: boolean; synced: number; failed: number; reason?: string };
};

export function registerIpcHandlers(ipcMain: IpcMain) {
  // ---- AUTH ----
  ipcMain.handle('auth:login', (_e, username: string, password: string) => {
    const row = getDb()
      .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(username) as
      | { id: string; username: string; password_hash: string; role: 'manager' | 'owner' }
      | undefined;
    if (!row) return { ok: false, error: 'Invalid credentials' };
    if (!bcrypt.compareSync(password, row.password_hash))
      return { ok: false, error: 'Invalid credentials' };
    return { ok: true, user: { id: row.id, username: row.username, role: row.role } };
  });

  ipcMain.handle(
    'auth:changePassword',
    (_e, userId: string, oldPassword: string, newPassword: string) => {
      const row = getDb()
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(userId) as { password_hash: string } | undefined;
      if (!row) return { ok: false, error: 'User not found' };
      if (!bcrypt.compareSync(oldPassword, row.password_hash))
        return { ok: false, error: 'Current password is incorrect' };
      const newHash = bcrypt.hashSync(newPassword, 10);
      getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
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
      getDb()
        .prepare(
          `INSERT INTO prices (meal_type, price_per_plate, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(meal_type) DO UPDATE SET price_per_plate=excluded.price_per_plate, updated_at=datetime('now')`
        )
        .run(mealType, pricePerPlate);
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

      printToken({ ...bill, restaurantName }).catch((err) =>
        console.error('Print failed:', err)
      );
      syncPendingBills().catch((err) => console.error('Sync failed:', err));

      return { ok: true, bill };
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

    // Best-effort cloud push so the void propagates. Failure is non-fatal —
    // next scheduled sync will retry.
    syncPendingBills().catch((e) => console.error('Sync after void failed:', e));

    return { ok: true };
  });

  ipcMain.handle(
    'bills:list',
    (
      _e,
      filter: { from?: string; to?: string; mealType?: 'lunch' | 'dinner'; limit?: number } = {}
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
      nextTokenNo: totals.bills + 1,
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

  // ---- SETTINGS ----
  ipcMain.handle('settings:get', (_e, key: string) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  });

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
    return { ok: true };
  });

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

  // ---- PRINTER ----
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
