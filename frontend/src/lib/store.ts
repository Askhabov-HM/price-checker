import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import type {CartListId, ChartScale} from './types';

const safeStorage = {
  getItem(name: string) {try {return localStorage.getItem(name);} catch {return null;}},
  setItem(name: string, value: string) {try {localStorage.setItem(name, value);} catch {}},
  removeItem(name: string) {try {localStorage.removeItem(name);} catch {}},
};
const legacyScale = safeStorage.getItem('price-checker-chart-scale') === 'checks' ? 'checks' : 'time';
type Preferences = {
  chartScale: ChartScale;
  setChartScale: (scale: ChartScale) => void;
  cartDiscounts: Record<CartListId, boolean>;
  setCartDiscount: (list: CartListId, enabled: boolean) => void;
};
export const usePreferences = create<Preferences>()(
  persist(set => ({chartScale: legacyScale, setChartScale: chartScale => set({chartScale}),
    cartDiscounts: {cart: false, 'my-cart': false},
    setCartDiscount: (list, enabled) => set(state => ({cartDiscounts: {...state.cartDiscounts, [list]: enabled}})),
  }), {
    name: 'price-checker-preferences', storage: createJSONStorage(() => safeStorage),
    merge: (saved, current) => {
      if (!saved) return current;
      const scale = (saved as {chartScale?: unknown} | undefined)?.chartScale;
      const discounts = (saved as {cartDiscounts?: Partial<Record<CartListId, unknown>>})?.cartDiscounts;
      return {...current, chartScale: scale === 'checks' ? 'checks' : 'time',
        cartDiscounts: {cart: discounts?.cart === true, 'my-cart': discounts?.['my-cart'] === true}};
    },
  }),
);
