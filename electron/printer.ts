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

export async function printToken(bill: Bill) {
  const printerName =
    (getDb().prepare("SELECT value FROM settings WHERE key='printer_name'").get() as
      | { value: string }
      | undefined)?.value ?? '';

  const date = new Date(bill.createdAt);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const data: PosPrintData[] = [
    {
      type: 'text',
      value: `${bill.restaurantName}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '16px',
        lineHeight: '1.1',
      },
    },
    {
      type: 'table',
      style: { width: '100%', borderCollapse: 'collapse', margin: '0', padding: '0' },
      tableHeader: [],
      tableBody: [
        [
          {
            type: 'text',
            value: `${dateStr} ${timeStr} ${bill.mealType.toUpperCase()}`,
            style: {
              textAlign: 'left',
              fontSize: '10px',
              lineHeight: '1.2',
              padding: '0',
              margin: '0',
            },
          },
          {
            // Trailing non-breaking spaces push the token away from the
            // paper's right edge — CSS padding/margin gets ignored here.
            type: 'text',
            value: `TOKEN #${bill.tokenNo}${NBSP}${NBSP}${NBSP}`,
            style: {
              textAlign: 'right',
              fontWeight: 'bold',
              fontSize: '14px',
              lineHeight: '1.2',
              padding: '0',
              margin: '0',
            },
          },
        ],
      ],
      tableFooter: [],
    },
    {
      type: 'text',
      value: `THALI x ${bill.plates}${NBSP}${NBSP}${NBSP}`,
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
      value: `TOTAL Rs.${bill.total}  -  ${bill.paymentMode.toUpperCase()}${NBSP}${NBSP}${NBSP}`,
      style: {
        ...fullWidth,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSize: '14px',
        lineHeight: '1.2',
      },
    },
    // Bottom feed: visible-but-white character with explicit height.
    // A real glyph is required; whitespace gets collapsed by the renderer.
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
    // top right bottom left — extra bottom margin gives the cutter clearance.
    margin: '0 0 30px 0',
    copies: 1,
    printerName: printerName || undefined,
    timeOutPerLine: 400,
    pageSize: '80mm',
    silent: true,
  };

  await PosPrinter.print(data, options);
}
