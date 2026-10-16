import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {vi.restoreAllMocks(); localStorage.clear(); vi.resetModules();});
it('migrates the previous chart preference and persists only UI preferences', async () => {
  vi.resetModules();
  localStorage.setItem('price-checker-chart-scale', 'checks');
  const {usePreferences} = await import('./store');
  expect(usePreferences.getState().chartScale).toBe('checks');
  usePreferences.getState().setChartScale('time');
  const saved = JSON.parse(localStorage.getItem('price-checker-preferences')!);
  expect(saved.state).toEqual({chartScale: 'time', cartDiscounts: {cart: false, 'my-cart': false}});
});
it('continues to work when browser storage is unavailable', async () => {
  vi.resetModules();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {throw new Error('Storage unavailable');});
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('Storage unavailable');});
  const {usePreferences} = await import('./store');
  expect(() => usePreferences.getState().setChartScale('checks')).not.toThrow();
  expect(() => usePreferences.getState().setCartDiscount('cart', true)).not.toThrow();
  expect(usePreferences.getState().chartScale).toBe('checks');
  expect(usePreferences.getState().cartDiscounts).toEqual({cart: true, 'my-cart': false});
});
it('rejects invalid saved chart scales', async () => {
  vi.resetModules();
  localStorage.setItem('price-checker-preferences', JSON.stringify({state: {chartScale: 'invalid'}, version: 0}));
  const {usePreferences} = await import('./store');
  expect(usePreferences.getState().chartScale).toBe('time');
});

it('persists each cart discount independently and restores them after a reload', async () => {
  vi.resetModules();
  const {usePreferences} = await import('./store');
  expect(usePreferences.getState().cartDiscounts).toEqual({cart: false, 'my-cart': false});
  usePreferences.getState().setCartDiscount('cart', true);
  expect(usePreferences.getState().cartDiscounts).toEqual({cart: true, 'my-cart': false});
  usePreferences.getState().setCartDiscount('my-cart', true);
  usePreferences.getState().setCartDiscount('cart', false);
  vi.resetModules();
  const restored = await import('./store');
  expect(restored.usePreferences.getState().cartDiscounts).toEqual({cart: false, 'my-cart': true});
});

it('migrates older preferences and rejects invalid persisted discount flags', async () => {
  vi.resetModules();
  localStorage.setItem('price-checker-preferences', JSON.stringify({state: {chartScale: 'checks'}, version: 0}));
  const older = await import('./store');
  expect(older.usePreferences.getState().chartScale).toBe('checks');
  expect(older.usePreferences.getState().cartDiscounts).toEqual({cart: false, 'my-cart': false});
  localStorage.setItem('price-checker-preferences', JSON.stringify({state: {chartScale: 'time', cartDiscounts: {cart: 'true', 'my-cart': 1}}, version: 0}));
  vi.resetModules();
  const invalid = await import('./store');
  expect(invalid.usePreferences.getState().cartDiscounts).toEqual({cart: false, 'my-cart': false});
});
