import { PosPrinter, PosPrintOptions, PosPrintData } from 'electron-pos-printer';
import { getDb } from './db';

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
};

const fullWidth = { width: '100%', display: 'block', margin: '0', padding: '0' } as const;

// Non-breaking space character — survives the renderer's whitespace collapse.
const NBSP = ' ';

// Solid horizontal rule that hugs the paper width. Bottom margin negative-trick
// not needed — borderTop on a zero-height div renders as a thin line.
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
    marginRight: '12px',
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
    marginRight: '28px',
  },
});

function fmtBillTimes(createdAt: string) {
  const date = new Date(createdAt);
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
  };
}

// Customer copy — full restaurant header (name, address, mobile) and a
// thank-you footer. Mirrors a typical retail receipt layout so the customer
// can use it as proof of purchase.
function buildCustomerSlip(bill: Bill): PosPrintData[] {
  const { dateStr, timeStr } = fmtBillTimes(bill.createdAt);
  const { address, mobile } = getRestaurantHeader();
  const data: PosPrintData[] = [
    {
      type: 'text',
      value: `${bill.restaurantName}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '17px',
        lineHeight: '1.15',
      },
    },
  ];
  if (address) {
    data.push({
      type: 'text',
      value: `${address}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '10px',
        lineHeight: '1.3',
      },
    });
  }
  if (mobile) {
    data.push({
      type: 'text',
      value: `Mob. ${mobile}${NBSP}${NBSP}${NBSP}`,
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
      style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
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
            value: `Bill No.: ${bill.tokenNo}${NBSP}${NBSP}${NBSP}`,
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
            value: `Meal: ${bill.mealType.toUpperCase()}${NBSP}${NBSP}${NBSP}`,
            style: { textAlign: 'right', fontSize: '11px', padding: '0', margin: '0' },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'table',
      style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
      tableHeader: [
        {
          type: 'text',
          value: 'No.Item',
          style: { textAlign: 'left', fontSize: '11px', fontWeight: 'bold', width: '40%' },
        },
        {
          type: 'text',
          value: 'QTY',
          style: { textAlign: 'right', fontSize: '11px', fontWeight: 'bold', width: '15%' },
        },
        {
          type: 'text',
          value: 'Price',
          style: { textAlign: 'right', fontSize: '11px', fontWeight: 'bold', width: '20%' },
        },
        {
          type: 'text',
          value: 'Amount',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '25%',
            paddingRight: '8px',
          },
        },
      ],
      tableBody: [
        [
          {
            type: 'text',
            value: '1 THALI',
            style: { textAlign: 'left', fontSize: '12px', fontWeight: 'bold', padding: '2px 0' },
          },
          {
            type: 'text',
            value: `${bill.plates}`,
            style: { textAlign: 'right', fontSize: '14px', fontWeight: 'bold', padding: '2px 0' },
          },
          {
            type: 'text',
            value: `${bill.pricePerPlate}.00`,
            style: { textAlign: 'right', fontSize: '11px', padding: '2px 0' },
          },
          {
            type: 'text',
            value: `${bill.total}.00${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontSize: '12px',
              fontWeight: 'bold',
              padding: '2px 0',
            },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'table',
      style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text',
            value: `Total Qty: ${bill.plates}`,
            style: { textAlign: 'left', fontSize: '11px', padding: '0', margin: '0' },
          },
          {
            type: 'text',
            value: `Sub Total ${bill.total}.00${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontSize: '11px',
              fontWeight: 'bold',
              padding: '0',
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
      value: `Grand Total Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}${NBSP}${NBSP}${NBSP}`,
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
      value: `Thanks for coming... Visit again !!!${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '10px',
        fontStyle: 'italic',
        lineHeight: '1.3',
      },
    },
    cutLine()
  );
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
      value: `${bill.restaurantName}${NBSP}${NBSP}${NBSP}`,
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
      value: `--- MANAGER COPY ---${NBSP}${NBSP}${NBSP}`,
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
      type: 'text',
      value: `Bill No   : ${bill.tokenNo}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'left',
        fontSize: '14px',
        fontWeight: 'bold',
        lineHeight: '1.3',
      },
    },
    {
      type: 'text',
      value: `Date : ${dateStr}  Time : ${timeStr}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'left',
        fontSize: '11px',
        lineHeight: '1.3',
      },
    },
    {
      type: 'text',
      value: `Meal : ${bill.mealType.toUpperCase()}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'left',
        fontSize: '11px',
        fontWeight: 'bold',
        lineHeight: '1.3',
      },
    },
    hr(),
    {
      type: 'table',
      style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
      tableHeader: [
        {
          type: 'text',
          value: 'SNo',
          style: { textAlign: 'left', fontSize: '11px', fontWeight: 'bold', width: '15%' },
        },
        {
          type: 'text',
          value: 'Item',
          style: { textAlign: 'left', fontSize: '11px', fontWeight: 'bold', width: '40%' },
        },
        {
          type: 'text',
          value: 'QTY',
          style: { textAlign: 'right', fontSize: '11px', fontWeight: 'bold', width: '20%' },
        },
        {
          type: 'text',
          value: 'Amount',
          style: {
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: 'bold',
            width: '25%',
            paddingRight: '8px',
          },
        },
      ],
      tableBody: [
        [
          {
            type: 'text',
            value: '1',
            style: { textAlign: 'left', fontSize: '12px', padding: '2px 0' },
          },
          {
            type: 'text',
            value: 'THALI',
            style: { textAlign: 'left', fontSize: '12px', fontWeight: 'bold', padding: '2px 0' },
          },
          {
            type: 'text',
            value: `${bill.plates}`,
            style: { textAlign: 'right', fontSize: '14px', fontWeight: 'bold', padding: '2px 0' },
          },
          {
            type: 'text',
            value: `${bill.total}.00${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontSize: '12px',
              fontWeight: 'bold',
              padding: '2px 0',
            },
          },
        ],
      ],
      tableFooter: [],
    },
    hr(),
    {
      type: 'text',
      value: `TOTAL Rs.${bill.total} - ${bill.paymentMode.toUpperCase()}${NBSP}${NBSP}${NBSP}`,
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
      value: `Verified by: __________________${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'left',
        fontSize: '11px',
        lineHeight: '1.4',
        marginTop: '4px',
      },
    },
    cutLine(),
  ];
}

export async function printToken(bill: Bill) {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';

  const options: PosPrintOptions = {
    preview: false,
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
      value: `${restaurantName}${NBSP}${NBSP}${NBSP}`,
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
      value: `PRINTER TEST${NBSP}${NBSP}${NBSP}`,
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
      value: `${stamp}${NBSP}${NBSP}${NBSP}`,
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
      value: `THALI x 1${NBSP}${NBSP}${NBSP}`,
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
      value: `If you can read this, the printer is OK.${NBSP}${NBSP}${NBSP}`,
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

export type DaySummary = {
  restaurantName: string;
  dayLabel: string; // e.g. "27/05/2026"
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
};

export async function printDaySummary(s: DaySummary) {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';

  const row = (label: string, value: string) => ({
    type: 'table' as const,
    style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
    tableHeader: [],
    tableBody: [
      [
        {
          type: 'text' as const,
          value: label,
          style: { textAlign: 'left', fontSize: '12px', padding: '0', margin: '0' },
        },
        {
          type: 'text' as const,
          value: `${value}${NBSP}${NBSP}${NBSP}`,
          style: {
            textAlign: 'right',
            fontWeight: 'bold',
            fontSize: '12px',
            padding: '0',
            margin: '0',
          },
        },
      ],
    ],
    tableFooter: [],
  });

  const data: PosPrintData[] = [
    {
      type: 'text',
      value: `${s.restaurantName}${NBSP}${NBSP}${NBSP}`,
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
      value: `DAY SUMMARY${NBSP}${NBSP}${NBSP}`,
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
      value: `${s.dayLabel}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        textAlign: 'center',
        fontSize: '11px',
        lineHeight: '1.2',
        marginBottom: '6px',
      },
    },
    row('Tokens issued', `${s.totalBills}`),
    row(
      'Token range',
      s.firstToken && s.lastToken ? `#${s.firstToken} – #${s.lastToken}` : '—'
    ),
    row('Plates sold', `${s.totalPlates}`),
    {
      type: 'text',
      value: ' ',
      style: { ...fullWidth, fontSize: '6px', height: '6px', lineHeight: '6px' },
    },
    row('Lunch plates', `${s.lunchPlates}`),
    row('Lunch revenue', `Rs.${s.lunchRevenue}`),
    row('Dinner plates', `${s.dinnerPlates}`),
    row('Dinner revenue', `Rs.${s.dinnerRevenue}`),
    {
      type: 'text',
      value: ' ',
      style: { ...fullWidth, fontSize: '6px', height: '6px', lineHeight: '6px' },
    },
    row('Cash', `Rs.${s.cashRevenue}`),
    row('UPI', `Rs.${s.upiRevenue}`),
    {
      type: 'text',
      value: ' ',
      style: { ...fullWidth, fontSize: '6px', height: '6px', lineHeight: '6px' },
    },
    {
      type: 'text',
      value: `TOTAL Rs.${s.totalRevenue}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '20px',
        lineHeight: '1.2',
      },
    },
    {
      type: 'text',
      value: '.',
      style: {
        ...fullWidth,
        color: 'white',
        fontSize: '30px',
        lineHeight: '30px',
        height: '30px',
      },
    },
  ];

  const options: PosPrintOptions = {
    preview: false,
    margin: '0 0 30px 0',
    copies: 1,
    printerName: printerName || undefined,
    timeOutPerLine: 400,
    pageSize: '80mm',
    silent: true,
  };

  await PosPrinter.print(data, options);
}
