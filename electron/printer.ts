import {
  PosPrinter,
  PosPrintOptions,
  PosPrintData,
  PosPrintTableField,
} from 'electron-pos-printer';
import { getDb } from './db';

type BillItem = {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
};

type Bill = {
  id: string;
  tokenNo: number;
  // Generic items count (legacy field name "plates"). Sum of every line-item
  // qty on the bill. Kept on the Bill type for callers that still pass it.
  plates: number;
  mealType: 'lunch' | 'dinner';
  // Legacy field — not used by the slip post-refactor (line items carry
  // their own price snapshots). Kept so older callers compile.
  pricePerPlate: number;
  total: number;
  paymentMode: 'cash' | 'upi';
  createdAt: string;
  restaurantName: string;
  // The line items on the bill. `items` is the canonical name; `extras`
  // is the legacy alias that older call sites still use.
  items?: BillItem[];
  extras?: BillItem[];
};

// Thermal printers (8 dots/mm) struggle with anti-aliased proportional fonts —
// thin strokes blur, numbers misalign. Monospace bitmap-style fonts render as
// hard-edged dot patterns that the printhead can reproduce cleanly. Consolas
// ships with Windows and has true bold; Courier New is a universal fallback.
const PRINT_FONT =
  '"Consolas", "Courier New", "Lucida Console", monospace';

// `calc(100% - 4mm)` bakes a right-side buffer into every full-width element.
// The H80i / POS80 driver ignores page-level right margins on this hardware,
// so the only reliable way to keep right-aligned amounts off the paper edge
// is to make the content itself narrower than the paper.
const fullWidth = {
  width: 'calc(100% - 4mm)',
  display: 'block',
  margin: '0',
  padding: '0',
  fontFamily: PRINT_FONT,
} as const;

// Same trick for tables, which don't spread `fullWidth`. Cells still get their
// own per-cell padding-right for inter-column gaps. Children inherit fontFamily.
const tableStyle = {
  width: 'calc(100% - 4mm)',
  borderCollapse: 'collapse' as const,
  margin: '0',
  padding: '0',
  fontFamily: PRINT_FONT,
};

// Non-breaking space character — survives the renderer's whitespace collapse.
const NBSP = ' ';

// Solid row dividers stay shorter than the bottom cut-line so the dashed
// tear guide is the most prominent horizontal line on the slip.
const hr = (): PosPrintData => ({
  type: 'text',
  value: '&nbsp;',
  style: {
    ...fullWidth,
    borderTop: '1px solid #000',
    fontSize: '0',
    lineHeight: '0',
    height: '0',
    width: 'auto',
    marginTop: '4px',
    marginBottom: '4px',
    marginRight: '6mm',
  },
});

const cutLine = (): PosPrintData => ({
  type: 'text',
  value: '&nbsp;',
  style: {
    ...fullWidth,
    borderTop: '1px dashed #000',
    fontSize: '0',
    lineHeight: '0',
    height: '0',
    width: 'auto',
    marginTop: '6px',
    marginRight: '2mm',
  },
});

function fmtBillTimes(createdAt: string) {
  // SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" with no
  // timezone marker. new Date() of that string parses as LOCAL time, which
  // makes a 14:30 IST bill (= UTC 09:00) print as "09:00". Normalize to ISO
  // with explicit Z so the Date is treated as UTC and getHours() returns the
  // correct local hour.
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

function getRestaurantHeader() {
  const get = (k: string) =>
    (getDb().prepare('SELECT value FROM settings WHERE key=?').get(k) as
      | { value: string }
      | undefined)?.value ?? '';
  return {
    address: get('restaurant_address'),
    mobile: get('restaurant_mobile'),
    insta: get('restaurant_insta'),
  };
}

// Reads the line items from whichever field the caller populated — `items`
// is the post-refactor canonical name; `extras` was the legacy alias.
function billLineItems(bill: Bill): BillItem[] {
  return bill.items ?? bill.extras ?? [];
}

// Sum of all line-item quantities. Mirrors what "Total Qty" means on a typical
// retail slip: the count of physical items across all rows, not the number of
// rows.
function totalItemQty(bill: Bill): number {
  return billLineItems(bill).reduce((s, x) => s + x.qty, 0);
}

// Customer item table rows — one row per line item. Cells match the
// 4-column header (No.Item / QTY / Price / Amount). Every menu item lives in
// `items` post-refactor (Thali included), so no special row.
function customerItemRows(bill: Bill): PosPrintTableField[][] {
  const rows: PosPrintTableField[][] = [];
  billLineItems(bill).forEach((x, i) => {
    rows.push([
      {
        type: 'text',
        value: `${i + 1}. ${x.name.toUpperCase()}`,
        style: {
          textAlign: 'left',
          fontSize: '12px',
          fontWeight: 'bold',
          padding: '2px 12px 2px 0',
        },
      },
      {
        type: 'text',
        value: `${x.qty}`,
        style: {
          textAlign: 'right',
          fontSize: '14px',
          fontWeight: 'bold',
          padding: '2px 12px 2px 0',
        },
      },
      {
        type: 'text',
        value: `${x.unitPrice}.00`,
        style: {
          textAlign: 'right',
          fontWeight: 'bold',
          fontSize: '11px',
          padding: '2px 12px 2px 0',
        },
      },
      {
        type: 'text',
        value: `${x.total}.00`,
        style: {
          textAlign: 'right',
          fontSize: '12px',
          fontWeight: 'bold',
          padding: '2px 16px 2px 0',
        },
      },
    ]);
  });
  return rows;
}

// Manager item table rows — 4 cols: SNo / Item / QTY / Amount (no Price col).
function managerItemRows(bill: Bill): PosPrintTableField[][] {
  const rows: PosPrintTableField[][] = [];
  billLineItems(bill).forEach((x, i) => {
    rows.push([
      {
        type: 'text',
        value: `${i + 1}`,
        style: { textAlign: 'left', fontSize: '12px', padding: '2px 12px 2px 0' },
      },
      {
        type: 'text',
        value: x.name.toUpperCase(),
        style: {
          textAlign: 'left',
          fontSize: '12px',
          fontWeight: 'bold',
          padding: '2px 12px 2px 0',
        },
      },
      {
        type: 'text',
        value: `${x.qty}`,
        style: {
          textAlign: 'right',
          fontSize: '14px',
          fontWeight: 'bold',
          padding: '2px 12px 2px 0',
        },
      },
      {
        type: 'text',
        value: `${x.total}.00`,
        style: {
          textAlign: 'right',
          fontSize: '12px',
          fontWeight: 'bold',
          padding: '2px 16px 2px 0',
        },
      },
    ]);
  });
  return rows;
}

// Customer copy — full restaurant header (name, address, mobile) and a
// thank-you footer. Mirrors a typical retail receipt layout so the customer
// can use it as proof of purchase.
function buildCustomerSlip(bill: Bill): PosPrintData[] {
  const { dateStr, timeStr } = fmtBillTimes(bill.createdAt);
  const { address, mobile, insta } = getRestaurantHeader();
  const data: PosPrintData[] = [
    {
      type: 'text',
      value: bill.restaurantName,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '17px',
        lineHeight: '1.15',
      },
    },
  ];
  // Address + mobile rendered as one wrapping block so the phone number runs
  // straight after the address instead of dropping to its own line. Centered
  // text with trailing NBSPs would shift visually left, so we keep it clean.
  const addressLine = [address, mobile ? `Mob. ${mobile}` : '']
    .filter(Boolean)
    .join(' ');
  if (addressLine) {
    data.push({
      type: 'text',
      value: addressLine,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '10px',
        lineHeight: '1.3',
        marginBottom: '2px',
      },
    });
  }
  data.push(
    hr(),
    {
      type: 'table',
      style: tableStyle,
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text',
            value: `Date: ${dateStr}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Bill No.: ${bill.tokenNo}${NBSP}${NBSP}${NBSP}${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontSize: '12px',
              fontWeight: 'bold',
              padding: '0',
              margin: '0',
            },
          },
        ],
        [
          {
            type: 'text',
            value: `Time: ${timeStr}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Meal: ${bill.mealType.toUpperCase()}${NBSP}${NBSP}${NBSP}${NBSP}${NBSP}`,
            style: { textAlign: 'right', fontSize: '11px', padding: '0', margin: '0' },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'table',
      style: tableStyle,
      tableHeader: [
        {
          type: 'text',
          value: 'No.Item',
          style: { textAlign: 'left', fontSize: '11px', fontWeight: 'bold', width: '35%' },
        },
        {
          type: 'text',
          value: 'QTY',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '15%',
            paddingRight: '12px',
          },
        },
        {
          type: 'text',
          value: 'Price',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '22%',
            paddingRight: '12px',
          },
        },
        {
          type: 'text',
          value: 'Amount',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '28%',
            paddingRight: '16px',
          },
        },
      ],
      tableBody: customerItemRows(bill),
      tableFooter: [],
    },
    hr(),
    {
      type: 'table',
      style: tableStyle,
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text',
            value: `Total Qty: ${totalItemQty(bill)}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Sub Total ${bill.total}.00`,
            style: {
              textAlign: 'right',
              fontSize: '11px',
              fontWeight: 'bold',
              padding: '0 16px 0 0',
              margin: '0',
            },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'text',
      value: `Grand Total Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '14px',
        padding: '4px 0',
      },
    },
    hr(),
    {
      type: 'text',
      value: `Thanks for coming... Visit again !!!`,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '10px',
        fontStyle: 'italic',
        lineHeight: '1.3',
      },
    }
  );
  if (insta) {
    data.push({
      type: 'text',
      value: `Instagram: ${insta}`,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '10px',
        lineHeight: '1.3',
      },
    });
  }
  data.push(cutLine());
  return data;
}

// Manager copy — minimal, kept by the cashier for end-of-day reconciliation.
// No address, no thanks footer; instead carries a "Verified" line so the
// owner can tick each slip while counting.
function buildManagerSlip(bill: Bill): PosPrintData[] {
  const { dateStr, timeStr } = fmtBillTimes(bill.createdAt);
  return [
    {
      type: 'text',
      value: bill.restaurantName,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '15px',
        lineHeight: '1.15',
      },
    },
    {
      type: 'text',
      value: '--- MANAGER COPY ---',
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '11px',
        fontWeight: 'bold',
        lineHeight: '1.2',
        marginBottom: '2px',
      },
    },
    hr(),
    {
      type: 'table',
      style: tableStyle,
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text',
            value: `Date: ${dateStr}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Bill No.: ${bill.tokenNo}${NBSP}${NBSP}${NBSP}${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontSize: '12px',
              fontWeight: 'bold',
              padding: '0',
              margin: '0',
            },
          },
        ],
        [
          {
            type: 'text',
            value: `Time: ${timeStr}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Meal: ${bill.mealType.toUpperCase()}${NBSP}${NBSP}${NBSP}${NBSP}${NBSP}`,
            style: { textAlign: 'right', fontSize: '11px', padding: '0', margin: '0' },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'table',
      style: tableStyle,
      tableHeader: [
        {
          type: 'text',
          value: 'SNo',
          style: {
            textAlign: 'left',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '12%',
            paddingRight: '12px',
          },
        },
        {
          type: 'text',
          value: 'Item',
          style: {
            textAlign: 'left',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '38%',
            paddingRight: '12px',
          },
        },
        {
          type: 'text',
          value: 'QTY',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '20%',
            paddingRight: '12px',
          },
        },
        {
          type: 'text',
          value: 'Amount',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '30%',
            paddingRight: '16px',
          },
        },
      ],
      tableBody: managerItemRows(bill),
      tableFooter: [],
    },
    hr(),
    {
      type: 'text',
      value: `TOTAL Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '14px',
        padding: '4px 0',
      },
    },
    hr(),
    // {
    //   type: 'text',
    //   value: `Verified by: __________________${NBSP}${NBSP}${NBSP}${NBSP}${NBSP}`,
    //   style: {
    //     ...fullWidth,
    //     textAlign: 'left',
    //     fontSize: '11px',
    //     lineHeight: '1.4',
    //     marginTop: '4px',
    //   },
    // },
    // cutLine(),
  ];
}

export async function printToken(bill: Bill) {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';

  const options: PosPrintOptions = {
    preview: false,
    // Right page margin keeps the H80i / POS80 from clipping right-aligned
    // amounts. Bottom feed is still driver-controlled (per project memory).
    margin: '0',
    copies: 1,
    printerName: printerName || undefined,
    timeOutPerLine: 400,
    pageSize: '80mm',
    silent: true,
  };

  // Two slips per bill: customer copy first (handed over), manager copy
  // second (kept for end-of-day verification). Sequential print jobs let the
  // printer auto-cut between them on cutter-equipped models; the dashed
  // bottom line is the manual tear guide for the rest.
  await PosPrinter.print(buildCustomerSlip(bill), options);
  await PosPrinter.print(buildManagerSlip(bill), options);
}

// Sample slip used to verify printer wiring without burning a real token. The
// shape mirrors `printToken` so any driver-side issues (margins, page-end
// behaviour, paper width) surface here too.
export async function printTest() {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';
  const restaurantName =
    (getDb().prepare("SELECT value FROM settings WHERE key='restaurant_name'").get() as
      | { value: string }
      | undefined)?.value ?? 'Restaurant';
  const now = new Date();
  const stamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })}`;

  const data: PosPrintData[] = [
    {
      type: 'text',
      value: restaurantName,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '16px',
        lineHeight: '1.1',
      },
    },
    {
      type: 'text',
      value: 'PRINTER TEST',
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '14px',
        lineHeight: '1.2',
      },
    },
    {
      type: 'text',
      value: stamp,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '11px',
        lineHeight: '1.2',
        marginBottom: '4px',
      },
    },
    {
      type: 'text',
      value: 'THALI x 1',
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '40px',
        marginTop: '2px',
        marginBottom: '2px',
        lineHeight: '1',
      },
    },
    {
      type: 'text',
      value: 'If you can read this, the printer is OK.',
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '11px',
        lineHeight: '1.2',
      },
    },
  ];

  const options: PosPrintOptions = {
    preview: false,
    // Right page margin keeps the H80i / POS80 from clipping right-aligned
    // amounts. Bottom feed is still driver-controlled (per project memory).
    margin: '0',
    copies: 1,
    printerName: printerName || undefined,
    timeOutPerLine: 400,
    pageSize: '80mm',
    silent: true,
  };

  await PosPrinter.print(data, options);
}

// ----- Day summary (Z-report) ------------------------------------------------

type MealBreakdown = {
  bills: number;
  plates: number;
  plateRevenue: number;
  revenue: number;
  extras: Array<{ name: string; qty: number; revenue: number }>;
};

export type DaySummary = {
  restaurantName: string;
  dayLabel: string;
  totalBills: number;
  totalPlates: number;
  totalRevenue: number;
  lunchPlates: number;
  lunchRevenue: number;
  dinnerPlates: number;
  dinnerRevenue: number;
  cashRevenue: number;
  upiRevenue: number;
  firstToken: number | null;
  lastToken: number | null;
  // Rich per-meal item breakdown — Thali plus every extra sold for that meal.
  lunch: MealBreakdown;
  dinner: MealBreakdown;
  // Cross-meal extras roll-up for the slip footer.
  extras: Array<{ name: string; qty: number; revenue: number }>;
};

export async function printDaySummary(s: DaySummary) {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';

  // Two-column label/value row, right-aligned value with the same 16px right
  // padding that the bill's Sub Total uses, so columns align across slips.
  const infoRow = (label: string, value: string, opts: { boldLabel?: boolean } = {}) =>
    ({
      type: 'table' as const,
      style: tableStyle,
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text' as const,
            value: label,
            style: {
              textAlign: 'left' as const,
              fontSize: '11px',
              fontWeight: opts.boldLabel ? ('bold' as const) : ('normal' as const),
              padding: '0',
              margin: '0',
            },
          },
          {
            type: 'text' as const,
            value,
            style: {
              textAlign: 'right' as const,
              fontWeight: 'bold' as const,
              fontSize: '11px',
              padding: '0 16px 0 0',
              margin: '0',
            },
          },
        ],
      ],
      tableFooter: [],
    });

  // 4-column item table (SNo / Item / QTY / Amount) — same shape as the
  // manager copy on each bill. Headers + body rows.
  const itemTableHeader: PosPrintTableField[] = [
    {
      type: 'text',
      value: 'SNo',
      style: {
        textAlign: 'left',
        fontSize: '11px',
        fontWeight: 'bold',
        width: '12%',
        paddingRight: '12px',
      },
    },
    {
      type: 'text',
      value: 'Item',
      style: {
        textAlign: 'left',
        fontSize: '11px',
        fontWeight: 'bold',
        width: '38%',
        paddingRight: '12px',
      },
    },
    {
      type: 'text',
      value: 'QTY',
      style: {
        textAlign: 'right',
        fontSize: '11px',
        fontWeight: 'bold',
        width: '20%',
        paddingRight: '12px',
      },
    },
    {
      type: 'text',
      value: 'Amount',
      style: {
        textAlign: 'right',
        fontSize: '11px',
        fontWeight: 'bold',
        width: '30%',
        paddingRight: '16px',
      },
    },
  ];

  const itemRow = (sno: number, name: string, qty: number, amount: number): PosPrintTableField[] => [
    {
      type: 'text',
      value: `${sno}`,
      style: { textAlign: 'left', fontSize: '11px', padding: '2px 12px 2px 0' },
    },
    {
      type: 'text',
      value: name,
      style: {
        textAlign: 'left',
        fontSize: '12px',
        fontWeight: 'bold',
        padding: '2px 12px 2px 0',
      },
    },
    {
      type: 'text',
      value: `${qty}`,
      style: {
        textAlign: 'right',
        fontSize: '13px',
        fontWeight: 'bold',
        padding: '2px 12px 2px 0',
      },
    },
    {
      type: 'text',
      value: `Rs.${amount}`,
      style: {
        textAlign: 'right',
        fontSize: '11px',
        fontWeight: 'bold',
        padding: '2px 16px 2px 0',
      },
    },
  ];

  const sectionHeader = (title: string): PosPrintData => ({
    type: 'text',
    value: title,
    style: {
      ...fullWidth,
      fontWeight: 'bold',
      textAlign: 'left',
      fontSize: '13px',
      lineHeight: '1.3',
    },
  });

  // Per-meal block: section header → 4-col item table → meal subtotal row.
  // Returns an empty list when the meal has no bills so the slip stays compact.
  // Every menu item (including Thali) lives in m.extras post-refactor, so we
  // just iterate that list.
  const mealBlock = (label: 'LUNCH' | 'DINNER', m: MealBreakdown): PosPrintData[] => {
    if (m.bills === 0) return [];
    const body: PosPrintTableField[][] = m.extras.map((x, i) =>
      itemRow(i + 1, x.name.toUpperCase(), x.qty, x.revenue)
    );
    return [
      sectionHeader(label),
      {
        type: 'table',
        style: tableStyle,
        tableHeader: itemTableHeader,
        tableBody: body,
        tableFooter: [],
      },
      infoRow(`${label === 'LUNCH' ? 'Lunch' : 'Dinner'} total`, `Rs.${m.revenue}`, {
        boldLabel: true,
      }),
      hr(),
    ];
  };

  const data: PosPrintData[] = [
    {
      type: 'text',
      value: s.restaurantName,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '17px',
        lineHeight: '1.15',
      },
    },
    {
      type: 'text',
      value: 'DAY SUMMARY',
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '13px',
        lineHeight: '1.2',
      },
    },
    {
      type: 'text',
      value: s.dayLabel,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '11px',
        lineHeight: '1.3',
      },
    },
    hr(),
    infoRow('Tokens issued', `${s.totalBills}`),
    infoRow(
      'Token range',
      s.firstToken && s.lastToken ? `#${s.firstToken} - #${s.lastToken}` : '-'
    ),
    infoRow('Plates sold', `${s.totalPlates}`),
    hr(),
    ...mealBlock('LUNCH', s.lunch),
    ...mealBlock('DINNER', s.dinner),
    infoRow('Cash', `Rs.${s.cashRevenue}`),
    infoRow('UPI', `Rs.${s.upiRevenue}`),
    hr(),
    {
      type: 'text',
      value: `TOTAL Rs.${s.totalRevenue}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '17px',
        lineHeight: '1.3',
        padding: '4px 0',
      },
    },
    cutLine(),
  ];

  const options: PosPrintOptions = {
    preview: false,
    margin: '0',
    copies: 1,
    printerName: printerName || undefined,
    timeOutPerLine: 400,
    pageSize: '80mm',
    silent: true,
  };

  await PosPrinter.print(data, options);
}
