import {readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {ValidationError} from '../../errors.js';
import {parseCartPage, latestFavorites, parseProductPage} from './parser.js';

const invalid = () => new ValidationError('Некорректный локальный снимок Ozon. Нужен манифест ozon-capture версии 1.');

function jsonFile(path, maxBytes) {
  if (!statSync(path).isFile() || statSync(path).size > maxBytes) throw invalid();
  try {return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));} catch {throw invalid();}
}

// Offline only: no account requests, price-history writes or access to the Randewoo database.
export function readSnapshot(path) {
  const manifestPath = resolve(path), manifest = jsonFile(manifestPath, 64 * 1024);
  if (manifest?.provider !== 'ozon-capture' || manifest.version !== 1 || !manifest.favorites
    || !Array.isArray(manifest.favorites.files) || !manifest.favorites.files.length || manifest.favorites.files.length > 20) throw invalid();
  const root = realpathSync(dirname(manifestPath));
  const read = name => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,100}\.network-response$/i.test(name) || name.includes('..')) throw invalid();
    const file = realpathSync(join(root, name));
    if (dirname(file) !== root) throw invalid();
    return jsonFile(file, 8 * 1024 * 1024);
  };
  const favorites = latestFavorites(manifest.favorites.files.map(read), manifest.favorites.limit ?? 30);
  const cart = manifest.cart ? parseCartPage(read(manifest.cart)) : null;
  const target = manifest.product;
  const product = target ? parseProductPage(read(target.file), target.external_id,
    target.banks ? {external_id: target.external_id, data: read(target.banks)} : null) : null;
  return {provider: 'ozon', source: 'saved_network_responses', live: false, network_requests_made: 0, favorites, cart, product};
}
