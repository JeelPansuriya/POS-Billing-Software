import { create } from 'zustand';
import type { MealType, User } from './types';

interface AppState {
  user: User | null;
  mealType: MealType;
  setUser: (u: User | null) => void;
  setMealType: (m: MealType) => void;
  logout: () => void;
}

function defaultMeal(): MealType {
  const h = new Date().getHours();
  // Lunch 11:00–16:59, dinner otherwise
  return h >= 11 && h < 17 ? 'lunch' : 'dinner';
}

export const useApp = create<AppState>((set) => ({
  user: null,
  mealType: defaultMeal(),
  setUser: (user) => {
    // Mirror the renderer's auth state into the main process so audit_log
    // entries can attribute actions to the logged-in user. Fire-and-forget:
    // a failed IPC call mustn't block the UI from advancing past login.
    if (user) {
      window.api.session.set({ id: user.id, username: user.username }).catch(() => {});
    } else {
      window.api.session.clear().catch(() => {});
    }
    set({ user });
  },
  setMealType: (mealType) => set({ mealType }),
  logout: () => {
    window.api.session.clear().catch(() => {});
    set({ user: null });
  },
}));
