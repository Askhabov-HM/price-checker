import {ValidationError} from '../../errors.js';

export const OZON_ORIGIN = 'https://www.ozon.ru';

// Slugs and tracking parameters are presentation details; the last numeric part is the SKU.
export function ozonProduct(value) {
  const invalid = () => new ValidationError('Нужна ссылка на товар https://www.ozon.ru/product/…');
  if (typeof value !== 'string' || /[\\\s]/u.test(value.trim())) throw invalid();
  let url;
  try {url = new URL(value.trim());} catch {throw invalid();}
  const authority = /^https:\/\/([^/?#]+)/i.exec(value.trim())?.[1];
  if (!['ozon.ru', 'www.ozon.ru'].includes(authority) || url.protocol !== 'https:' || url.username || url.password) throw invalid();
  let path;
  try {path = decodeURIComponent(url.pathname);} catch {throw invalid();}
  const segment = /^\/product\/([^/\\\s?#]+)\/?$/u.exec(path)?.[1];
  const externalId = segment && /(?:^|-)([1-9]\d{0,19})$/.exec(segment)?.[1];
  if (!externalId || /[\u0000-\u001f\u007f]/u.test(path)) throw invalid();
  return {url: OZON_ORIGIN + '/product/' + encodeURIComponent(segment) + '/', external_id: externalId};
}

export function probeTarget(value) {
  if (value == null) return {url: OZON_ORIGIN + '/', kind: 'home', external_id: null};
  return {...ozonProduct(value), kind: 'product'};
}
