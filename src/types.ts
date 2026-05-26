import type { Api } from '../electron/preload';

declare global {
  interface Window {
    api: Api;
  }
}

export type Role = 'manager' | 'owner';
export type MealType = 'lunch' | 'dinner';
export type PaymentMode = 'cash' | 'upi';

export interface User {
  id: string;
  username: string;
  role: Role;
}

export interface Bill {
  id: string;
  token_no: number;
  plates: number;
  meal_type: MealType;
  price_per_plate: number;
  total: number;
  payment_mode: PaymentMode;
  created_at: string;
  sync_status: 'pending' | 'synced' | 'failed';
}
