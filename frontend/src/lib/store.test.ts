import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {vi.restoreAllMocks(); localStorage.clear(); vi.resetModules();});
it('migrates the previous chart preference and persists only UI preferences', async () => {
  vi.resetModules();
  localStorage.setItem('price-checker-chart-scale', 'checks');
  const {usePreferences} = await import('./store');
  expect(usePreferences.getState().chartScale).toBe('checks');
  usePreferences.getState().setChartScale('time');
  const saved = JSON.parse(localStorage.getItem('price-checker-preferences')!);
  expect(saved.state).toEqual({chartScale: 'time'});
});
it('continues to work when browser storage is unavailable', async () => {
  vi.resetModules();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {throw new Error('Storage unavailable');});
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('Storage unavailable');});
  const {usePreferences} = await import('./store');
  expect(() => usePreferences.getState().setChartScale('checks')).not.toThrow();
  expect(usePreferences.getState().chartScale).toBe('checks');
});
it('rejects invalid saved chart scales', async () => {
  vi.resetModules();
  localStorage.setItem('price-checker-preferences', JSON.stringify({state: {chartScale: 'invalid'}, version: 0}));
  const {usePreferences} = await import('./store');
  expect(usePreferences.getState().chartScale).toBe('time');
});
