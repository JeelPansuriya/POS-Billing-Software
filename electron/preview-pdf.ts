import { BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from './db';

type BillExtra = {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
};

type Bill = {
  id: string;
  tokenNo: number;
  plates: number;
  mealType: 'lunch' | 'dinner';
  pricePerPlate: number;
  total: number;
  paymentMode: 'cash' | 'upi';
  createdAt: string;
  restaurantName: string;
  restaurantAddress: string;
  restaurantMobile: string;
  restaurantInsta: string;
  extras: BillExtra[];
};

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

function fmtTimes(createdAt: string) {
  // Same UTC-vs-local fix as printer.ts: SQLite's space-separated UTC string
  // is parsed as local by JS unless we explicitly mark it as Z.
  const iso = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return { dateStr: `${dd}-${mm}-${yyyy}`, timeStr: `${hh}:${mi}:${ss}` };
}

function customerSlipHtml(bill: Bill): string {
  const { dateStr, timeStr } = fmtTimes(bill.createdAt);
  const name = escapeHtml(bill.restaurantName);
  const addr = escapeHtml(bill.restaurantAddress);
  const mob = escapeHtml(bill.restaurantMobile);
  const insta = escapeHtml(bill.restaurantInsta);
  const addressLine = [addr, mob ? `Mob. ${mob}` : ''].filter(Boolean).join(' ');
  return `
<div class="slip">
  <div class="full" style="font-weight:bold;text-align:center;font-size:17px;line-height:1.15;">${name}</div>
  ${addressLine ? `<div class="full" style="text-align:center;font-size:10px;line-height:1.3;margin-bottom:2px;">${addressLine}</div>` : ''}
  <div class="hr"></div>
  <table>
    <tr>
      <td style="text-align:left;font-size:11px;">Date: ${dateStr}</td>
      <td style="text-align:right;font-size:12px;font-weight:bold;">Bill No.: ${bill.tokenNo}</td>
    </tr>
    <tr>
      <td style="text-align:left;font-size:11px;">Time: ${timeStr}</td>
      <td style="text-align:right;font-size:11px;">Meal: ${bill.mealType.toUpperCase()}</td>
    </tr>
  </table>
  <div class="hr"></div>
  <table>
    <thead><tr>
      <th style="text-align:left;font-size:11px;width:35%;">No.Item</th>
      <th style="text-align:right;font-size:11px;width:15%;padding-right:12px;">QTY</th>
      <th style="text-align:right;font-size:11px;width:22%;padding-right:12px;">Price</th>
      <th style="text-align:right;font-size:11px;width:28%;padding-right:16px;">Amount</th>
    </tr></thead>
    <tbody>
      ${bill.extras.map((x, i) => `
      <tr>
        <td style="text-align:left;font-size:12px;font-weight:bold;padding-right:12px;">${i + 1}. ${escapeHtml(x.name.toUpperCase())}</td>
        <td style="text-align:right;font-size:14px;font-weight:bold;padding-right:12px;">${x.qty}</td>
        <td style="text-align:right;font-size:11px;font-weight:bold;padding-right:12px;">${x.unitPrice}.00</td>
        <td style="text-align:right;font-size:12px;font-weight:bold;padding-right:16px;">${x.total}.00</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="hr"></div>
  <table>
    <tr>
      <td style="text-align:left;font-size:11px;">Total Qty: ${bill.extras.reduce((s, x) => s + x.qty, 0)}</td>
      <td style="text-align:right;font-size:11px;font-weight:bold;">Sub Total ${bill.total}.00</td>
    </tr>
  </table>
  <div class="hr"></div>
  <div class="full" style="font-weight:bold;text-align:center;font-size:14px;padding:4px 0;">Grand Total Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}</div>
  <div class="hr"></div>
  <div class="full" style="text-align:center;font-size:10px;font-style:italic;line-height:1.3;">Thanks for coming... Visit again !!!</div>
  ${insta ? `<div class="full" style="text-align:center;font-size:10px;line-height:1.3;">Insta: ${insta}</div>` : ''}
  <div class="cut"></div>
</div>`;
}

function managerSlipHtml(bill: Bill): string {
  const { dateStr, timeStr } = fmtTimes(bill.createdAt);
  const name = escapeHtml(bill.restaurantName);
  return `
<div class="slip">
  <div class="full" style="font-weight:bold;text-align:center;font-size:15px;line-height:1.15;">${name}</div>
  <div class="full" style="text-align:center;font-size:11px;font-weight:bold;line-height:1.2;margin-bottom:2px;">--- MANAGER COPY ---</div>
  <div class="hr"></div>
  <table>
    <tr>
      <td style="text-align:left;font-size:11px;">Date: ${dateStr}</td>
      <td style="text-align:right;font-size:13px;font-weight:bold;">Bill No.: ${bill.tokenNo}</td>
    </tr>
    <tr>
      <td style="text-align:left;font-size:11px;">Time: ${timeStr}</td>
      <td style="text-align:right;font-size:11px;font-weight:bold;">Meal: ${bill.mealType.toUpperCase()}</td>
    </tr>
  </table>
  <div class="hr"></div>
  <table>
    <thead><tr>
      <th style="text-align:left;font-size:11px;width:12%;padding-right:12px;">SNo</th>
      <th style="text-align:left;font-size:11px;width:38%;padding-right:12px;">Item</th>
      <th style="text-align:right;font-size:11px;width:20%;padding-right:12px;">QTY</th>
      <th style="text-align:right;font-size:11px;width:30%;padding-right:16px;">Amount</th>
    </tr></thead>
    <tbody>
      ${bill.extras.map((x, i) => `
      <tr>
        <td style="text-align:left;font-size:12px;padding-right:12px;">${i + 1}</td>
        <td style="text-align:left;font-size:12px;font-weight:bold;padding-right:12px;">${escapeHtml(x.name.toUpperCase())}</td>
        <td style="text-align:right;font-size:14px;font-weight:bold;padding-right:12px;">${x.qty}</td>
        <td style="text-align:right;font-size:12px;font-weight:bold;padding-right:16px;">${x.total}.00</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="hr"></div>
  <div class="full" style="font-weight:bold;text-align:center;font-size:14px;padding:4px 0;">TOTAL Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}</div>
  <div class="hr"></div>
  <div class="full" style="text-align:left;font-size:11px;line-height:1.4;margin-top:4px;">Verified by: __________________</div>
  <div class="cut"></div>
</div>`;
}

function buildTokenHtml(bill: Bill): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 6px 0 6px 8px; font-family: "Consolas", "Courier New", "Lucida Console", monospace; color: #000; }
.full { width: calc(100% - 4mm); display: block; }
.slip { page-break-after: always; }
.slip:last-child { page-break-after: auto; }
.hr { border-top: 1px solid #000; margin: 4px 6mm 4px 0; height: 0; }
.cut { border-top: 1px dashed #000; margin: 6px 2mm 0 0; height: 0; }
table { width: calc(100% - 4mm); border-collapse: collapse; }
td, th { padding: 2px 0; }
</style></head><body>
${customerSlipHtml(bill)}
${managerSlipHtml(bill)}
</body></html>`;
}

function loadSettings() {
  const get = (k: string) =>
    (getDb().prepare('SELECT value FROM settings WHERE key=?').get(k) as
      | { value: string }
      | undefined)?.value ?? '';
  return {
    name: get('restaurant_name') || 'Jay Girr Kathiyawadi',
    address: get('restaurant_address'),
    mobile: get('restaurant_mobile'),
    insta: get('restaurant_insta'),
  };
}

function loadSampleBill(): Bill {
  const s = loadSettings();
  // Include 1-2 sample extras when the catalog has any, so the layout shows
  // the multi-row item table by default.
  const sampleExtras = (getDb()
    .prepare(
      'SELECT name, unit_price as unitPrice FROM extras_catalog WHERE active = 1 ORDER BY sort_order, name LIMIT 2'
    )
    .all() as Array<{ name: string; unitPrice: number }>).map((x, i) => ({
    name: x.name,
    qty: i + 1,
    unitPrice: x.unitPrice,
    total: x.unitPrice * (i + 1),
  }));
  const extrasTotal = sampleExtras.reduce((s, x) => s + x.total, 0);
  return {
    id: 'sample',
    tokenNo: 183,
    plates: 4,
    mealType: 'dinner',
    pricePerPlate: 120,
    total: 480 + extrasTotal,
    paymentMode: 'cash',
    createdAt: new Date().toISOString(),
    restaurantName: s.name,
    restaurantAddress: s.address,
    restaurantMobile: s.mobile,
    restaurantInsta: s.insta,
    extras: sampleExtras,
  };
}

function loadRealBill(billId: string): Bill | null {
  const row = getDb()
    .prepare(
      `SELECT id, token_no, plates, meal_type, price_per_plate, total, payment_mode, created_at
         FROM bills WHERE id = ?`
    )
    .get(billId) as
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
  if (!row) return null;
  const s = loadSettings();
  const extras = getDb()
    .prepare(
      'SELECT name, qty, unit_price as unitPrice, total FROM bill_items WHERE bill_id = ? ORDER BY sort_order, name'
    )
    .all(row.id) as Array<{ name: string; qty: number; unitPrice: number; total: number }>;
  return {
    id: row.id,
    tokenNo: row.token_no,
    plates: row.plates,
    mealType: row.meal_type,
    pricePerPlate: row.price_per_plate,
    total: row.total,
    paymentMode: row.payment_mode,
    createdAt: row.created_at,
    restaurantName: s.name,
    restaurantAddress: s.address,
    restaurantMobile: s.mobile,
    restaurantInsta: s.insta,
    extras,
  };
}

/**
 * Render both slips (customer + manager) to PDF and open it in the OS PDF
 * viewer. Each slip is its own page so the preview matches what comes off
 * the printer when printToken fires its two sequential print jobs.
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
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    const outPath = path.join(app.getPath('userData'), 'token-preview.pdf');
    await fs.writeFile(outPath, pdf);
    await shell.openPath(outPath);
    return { ok: true, path: outPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    win.destroy();
  }
}
