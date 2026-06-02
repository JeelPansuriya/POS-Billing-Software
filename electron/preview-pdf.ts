import { BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from './db';

type Bill = {
  id: string;
  tokenNo: number;
  plates: number;
  mealType: 'lunch' | 'dinner';
  total: number;
  paymentMode: 'cash' | 'upi';
  createdAt: string;
  restaurantName: string;
};

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

function buildTokenHtml(bill: Bill): string {
  const date = new Date(bill.createdAt);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const dateStr = `${dd}-${mm}-${yyyy}`;
  const timeStr = `${hh}:${mi}:${ss}`;
  const SEP = '================================';
  const name = escapeHtml(bill.restaurantName);

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 6px 8px; font-family: Arial, sans-serif; color: #000; }
.full { width: 100%; display: block; }
.sep { text-align: center; font-size: 10px; line-height: 1; margin: 2px 0; letter-spacing: -1px; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 2px 0; }
</style></head><body>
<div class="full" style="font-weight:bold;text-align:center;font-size:20px;line-height:1.1;margin-bottom:4px;">${name}</div>
<div class="full sep">${SEP}</div>
<div class="full" style="text-align:left;font-size:16px;font-weight:bold;line-height:1.3;">Bill No&nbsp;&nbsp;&nbsp;: ${bill.tokenNo}</div>
<div class="full" style="text-align:left;font-size:11px;line-height:1.3;">Date : ${dateStr} | Time : ${timeStr}</div>
<div class="full" style="text-align:left;font-size:13px;font-weight:bold;line-height:1.3;">Meal&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ${bill.mealType.toUpperCase()}</div>
<div class="full sep">${SEP}</div>
<table>
<thead><tr>
<th style="text-align:left;font-size:11px;width:15%;">SNo</th>
<th style="text-align:left;font-size:11px;width:55%;">NAME</th>
<th style="text-align:right;font-size:11px;width:30%;padding-right:12px;">QTY</th>
</tr></thead>
<tbody><tr>
<td style="text-align:left;font-size:12px;">1</td>
<td style="text-align:left;font-size:13px;font-weight:bold;">THALI</td>
<td style="text-align:right;font-size:16px;font-weight:bold;padding-right:12px;">${bill.plates}</td>
</tr></tbody>
</table>
<div class="full sep">${SEP}</div>
<div class="full" style="font-weight:bold;text-align:center;padding:4px 0;font-size:15px;line-height:1.2;">TOTAL Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}</div>
<div class="full" style="border-top:1px dashed #000;height:0;margin-top:4px;margin-right:28px;"></div>
</body></html>`;
}

function loadSampleBill(): Bill {
  const restaurantName =
    (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
      | { value: string }
      | undefined)?.value ?? 'Jay Girr Kathiyawadi';
  return {
    id: 'sample',
    tokenNo: 183,
    plates: 4,
    mealType: 'dinner',
    total: 480,
    paymentMode: 'cash',
    createdAt: new Date().toISOString(),
    restaurantName,
  };
}

function loadRealBill(billId: string): Bill | null {
  const row = getDb()
    .prepare(
      `SELECT id, token_no, plates, meal_type, total, payment_mode, created_at
         FROM bills WHERE id = ?`
    )
    .get(billId) as
    | {
        id: string;
        token_no: number;
        plates: number;
        meal_type: 'lunch' | 'dinner';
        total: number;
        payment_mode: 'cash' | 'upi';
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  const restaurantName =
    (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
      | { value: string }
      | undefined)?.value ?? 'Restaurant';
  return {
    id: row.id,
    tokenNo: row.token_no,
    plates: row.plates,
    mealType: row.meal_type,
    total: row.total,
    paymentMode: row.payment_mode,
    createdAt: row.created_at,
    restaurantName,
  };
}

/**
 * Render the token slip layout to a PDF and open it in the OS PDF viewer.
 * Used to verify the receipt design without burning thermal paper or even
 * having a printer attached. Without billId we render a sample bill.
 */
export async function previewTokenPdf(
  billId?: string
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const bill = billId ? loadRealBill(billId) : loadSampleBill();
  if (!bill) return { ok: false, error: 'Bill not found' };

  const html = buildTokenHtml(bill);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // preferCSSPageSize lets the @page { size: 80mm auto } in the HTML drive
    // dimensions, so the PDF is exactly 80mm wide with auto-height.
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    const outPath = path.join(app.getPath('userData'), 'token-preview.pdf');
    await fs.writeFile(outPath, pdf);
    const openErr = await shell.openPath(outPath);
    if (openErr) {
      return { ok: true, path: outPath };
    }
    return { ok: true, path: outPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    win.destroy();
  }
}
