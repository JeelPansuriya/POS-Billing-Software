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
  setUser: (user) => set({ user }),
  setMealType: (mealType) => set({ mealType }),
  logout: () => set({ user: null }),
}));
