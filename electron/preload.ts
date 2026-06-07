import { contextBridge, ipcRenderer } from 'electron';

const api = {
  session: {
    set: (user: { id: string; username: string } | null) =>
      ipcRenderer.invoke('session:set', user),
    clear: () => ipcRenderer.invoke('session:clear'),
  },
  auth: {
    login: (username: string, password: string) =>
      ipcRenderer.invoke('auth:login', username, password),
    changePassword: (userId: string, oldPassword: string, newPassword: string) =>
      ipcRenderer.invoke('auth:changePassword', userId, oldPassword, newPassword),
  },
  prices: {
    get: () => ipcRenderer.invoke('prices:get'),
    set: (mealType: 'lunch' | 'dinner', price: number) =>
      ipcRenderer.invoke('prices:set', mealType, price),
  },
  extras: {
    list: () =>
      ipcRenderer.invoke('extras:list') as Promise<
        Array<{
          id: string;
          name: string;
          lunchPrice: number;
          dinnerPrice: number;
          plateWeight: number;
          active: number;
          sortOrder: number;
          shortcutKey: string | null;
        }>
      >,
    listAll: () =>
      ipcRenderer.invoke('extras:listAll') as Promise<
        Array<{
          id: string;
          name: string;
          lunchPrice: number;
          dinnerPrice: number;
          plateWeight: number;
          active: number;
          sortOrder: number;
          shortcutKey: string | null;
        }>
      >,
    upsert: (payload: {
      id?: string;
      name: string;
      lunchPrice: number;
      dinnerPrice: number;
      plateWeight: number;
      active: boolean;
      sortOrder: number;
      shortcutKey?: string | null;
    }) =>
      ipcRenderer.invoke('extras:upsert', payload) as Promise<
        { ok: true; id: string } | { ok: false; error: string }
      >,
    delete: (id: string) =>
      ipcRenderer.invoke('extras:delete', id) as Promise<{ ok: boolean; error?: string }>,
  },
  bills: {
    create: (payload: {
      mealType: 'lunch' | 'dinner';
      paymentMode: 'cash' | 'upi';
      items: Array<{ itemId: string; qty: number }>;
    }) => ipcRenderer.invoke('bills:create', payload),
    testPrint: (payload: {
      mealType: 'lunch' | 'dinner';
      paymentMode: 'cash' | 'upi';
      items: Array<{ itemId: string; qty: number }>;
    }) =>
      ipcRenderer.invoke('bills:testPrint', payload) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    list: (filter?: {
      from?: string;
      to?: string;
      mealType?: 'lunch' | 'dinner';
      tokenNo?: number;
      limit?: number;
    }) => ipcRenderer.invoke('bills:list', filter ?? {}),
    void: (billId: string, reason: string) =>
      ipcRenderer.invoke('bills:void', billId, reason) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    edit: (payload: {
      billId: string;
      paymentMode: 'cash' | 'upi';
      items: Array<{ itemId: string; qty: number }>;
    }) =>
      ipcRenderer.invoke('bills:edit', payload) as Promise<
        { ok: true; total: number } | { ok: false; error: string }
      >,
  },
  analytics: {
    summary: (range: { from: string; to: string }) =>
      ipcRenderer.invoke('analytics:summary', range),
    hourly: (range: { from: string; to: string }) =>
      ipcRenderer.invoke('analytics:hourly', range) as Promise<
        Array<{ hour: number; bills: number; plates: number; revenue: number }>
      >,
  },
  stats: {
    today: () =>
      ipcRenderer.invoke('stats:today') as Promise<{
        nextTokenNo: number;
        bills: number;
        plates: number;
        revenue: number;
        cash: number;
        upi: number;
      }>,
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  },
  sync: {
    now: () => ipcRenderer.invoke('sync:now'),
    pendingCount: () => ipcRenderer.invoke('sync:pendingCount'),
    menuNow: () =>
      ipcRenderer.invoke('sync:menuNow') as Promise<
        { ok: true; items: number } | { ok: false; error: string }
      >,
    cloudDiff: () =>
      ipcRenderer.invoke('sync:cloudDiff') as Promise<
        | {
            ok: true;
            localBills: number;
            cloudBills: number;
            onlyLocalBills: string[];
            onlyCloudBills: string[];
            mismatchedBills: Array<{
              id: string;
              field: string;
              local: any;
              cloud: any;
            }>;
            localItems: number;
            cloudItems: number;
            onlyLocalItems: number;
            onlyCloudItems: number;
          }
        | { ok: false; reason: string }
      >,
    cloudRestore: (mode: 'safe' | 'force') =>
      ipcRenderer.invoke('sync:cloudRestore', mode) as Promise<
        | {
            ok: true;
            insertedBills: number;
            insertedItems: number;
            deletedBills: number;
            deletedItems: number;
          }
        | { ok: false; reason: string }
      >,
  },
  printer: {
    reprint: (billId: string) => ipcRenderer.invoke('printer:reprint', billId),
    test: () =>
      ipcRenderer.invoke('printer:test') as Promise<{ ok: boolean; error?: string }>,
    previewPdf: (billId?: string) =>
      ipcRenderer.invoke('preview:tokenPdf', billId) as Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >,
  },
  audit: {
    list: (filter?: { limit?: number; action?: string }) =>
      ipcRenderer.invoke('audit:list', filter ?? {}) as Promise<
        Array<{
          id: string;
          at: string;
          actor_user_id: string | null;
          actor_username: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          details: string | null;
        }>
      >,
  },
  cash: {
    get: (dayIso?: string) =>
      ipcRenderer.invoke('cash:get', dayIso) as Promise<{
        day: string;
        systemCash: number;
        counted: {
          countedCash: number;
          variance: number;
          note: string | null;
          recordedAt: string;
          recordedBy: string | null;
        } | null;
      }>,
    set: (payload: { day?: string; countedCash: number; note?: string }) =>
      ipcRenderer.invoke('cash:set', payload) as Promise<{
        ok: boolean;
        day: string;
        systemCash: number;
        variance: number;
      }>,
  },
  db: {
    integrityCheck: () =>
      ipcRenderer.invoke('db:integrityCheck') as Promise<{
        ok: boolean;
        messages: string[];
      }>,
  },
  restore: {
    fromCsv: (payload: { filePath?: string; commit?: boolean }) =>
      ipcRenderer.invoke('restore:fromCsv', payload) as Promise<
        | { ok: false; error?: string; canceled?: boolean }
        | { ok: true; preview: true; parsed: number; toInsert: number; skipped: number }
        | { ok: true; preview: false; inserted: number; skipped: number }
      >,
  },
  exportLocal: {
    run: (dayIso?: string) =>
      ipcRenderer.invoke('export:run', dayIso) as Promise<{
        ok: boolean;
        path?: string;
        rows: number;
        error?: string;
      }>,
    openFolder: () =>
      ipcRenderer.invoke('export:openFolder') as Promise<{ ok: boolean; path: string }>,
    getDir: () => ipcRenderer.invoke('export:getDir') as Promise<string>,
    pickDir: () =>
      ipcRenderer.invoke('export:pickDir') as Promise<{ ok: boolean; path?: string }>,
  },
  updates: {
    status: () =>
      ipcRenderer.invoke('updates:status') as Promise<{
        phase:
          | 'idle'
          | 'checking'
          | 'available'
          | 'not-available'
          | 'downloading'
          | 'downloaded'
          | 'error';
        version: string;
        newVersion?: string;
        progressPct?: number;
        error?: string;
        checkedAt?: string;
      }>,
    check: () =>
      ipcRenderer.invoke('updates:check') as Promise<{ ok: boolean; error?: string }>,
    install: () => ipcRenderer.invoke('updates:install'),
    onEvent: (
      cb: (s: {
        phase:
          | 'idle'
          | 'checking'
          | 'available'
          | 'not-available'
          | 'downloading'
          | 'downloaded'
          | 'error';
        version: string;
        newVersion?: string;
        progressPct?: number;
        error?: string;
        checkedAt?: string;
      }) => void
    ) => {
      const listener = (_e: unknown, s: any) => cb(s);
      ipcRenderer.on('updates:event', listener);
      return () => {
        ipcRenderer.off('updates:event', listener);
      };
    },
  },
  day: {
    summary: (dayIso?: string) =>
      ipcRenderer.invoke('day:summary', dayIso) as Promise<{
        day: string;
        totalBills: number;
        totalPlates: number;
        totalRevenue: number;
        firstToken: number | null;
        lastToken: number | null;
        lunchPlates: number;
        lunchRevenue: number;
        dinnerPlates: number;
        dinnerRevenue: number;
        cashRevenue: number;
        upiRevenue: number;
        lunch: {
          bills: number;
          plates: number;
          plateRevenue: number;
          revenue: number;
          extras: Array<{ name: string; qty: number; revenue: number }>;
        };
        dinner: {
          bills: number;
          plates: number;
          plateRevenue: number;
          revenue: number;
          extras: Array<{ name: string; qty: number; revenue: number }>;
        };
        extras: Array<{ name: string; qty: number; revenue: number }>;
      }>,
    print: (dayIso?: string) =>
      ipcRenderer.invoke('day:print', dayIso) as Promise<{
        printed: boolean;
        printError?: string;
        sync: { ok: boolean; synced: number; failed: number; reason?: string };
      }>,
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
