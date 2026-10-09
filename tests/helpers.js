import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const cleanups = new WeakMap();
export function cleanup(t, action) {cleanups.get(t).push(action);}

export function temporary(t) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'price-checker-test-'));
  const actions = []; cleanups.set(t, actions);
  t.after(async () => {
    for (const action of actions.toReversed()) await action();
    if (dirname(root) !== parent || !basename(root).startsWith('price-checker-test-')) throw new Error('Unsafe temporary cleanup path');
    rmSync(root, {recursive: true, force: true});
  });
  return root;
}
export const item = (extra = {}) => ({url: 'https://randewoo.ru/product/test-fragrance', sku: '123', brand: 'Brand', name: 'Fragrance',
  variant: 'парфюмерная вода 1,5мл', price_kopecks: 15000, in_stock: true, status: 'ok', ...extra});
