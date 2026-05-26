import { contextBridge, ipcRenderer } from 'electron';

const api = {
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
  bills: {
    create: (payload: {
      plates: number;
      mealType: 'lunch' | 'dinner';
      paymentMode: 'cash' | 'upi';
    }) => ipcRenderer.invoke('bills:create', payload),
    list: (filter?: { from?: string; to?: string; mealType?: 'lunch' | 'dinner'; limit?: number }) =>
      ipcRenderer.invoke('bills:list', filter ?? {}),
  },
  analytics: {
    summary: (range: { from: string; to: string }) =>
      ipcRenderer.invoke('analytics:summary', range),
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
  },
  printer: {
    reprint: (billId: string) => ipcRenderer.invoke('printer:reprint', billId),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
