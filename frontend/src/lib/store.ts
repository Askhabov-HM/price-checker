import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import type {ChartScale} from './types';

const safeStorage = {
  getItem(name: string) {try {return localStorage.getItem(name);} catch {return null;}},
  setItem(name: string, value: string) {try {localStorage.setItem(name, value);} catch {}},
  removeItem(name: string) {try {localStorage.removeItem(name);} catch {}},
};
const legacyScale = safeStorage.getItem('price-checker-chart-scale') === 'checks' ? 'checks' : 'time';
export const usePreferences = create<{chartScale: ChartScale; setChartScale: (scale: ChartScale) => void}>()(
  persist(set => ({chartScale: legacyScale, setChartScale: chartScale => set({chartScale})}), {
    name: 'price-checker-preferences', storage: createJSONStorage(() => safeStorage),
    merge: (saved, current) => {
      if (!saved) return current;
      const scale = (saved as {chartScale?: unknown} | undefined)?.chartScale;
      return {...current, chartScale: scale === 'checks' ? 'checks' : 'time'};
    },
  }),
);
