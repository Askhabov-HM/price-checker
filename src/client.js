import {readFileSync} from 'node:fs';
import {load} from 'cheerio';
import {AuthError, FetchError, ValidationError} from './errors.js';
import {CurlTransport, quote} from './randewoo-transport.js';
export {quote} from './randewoo-transport.js';

const ORIGIN = 'https://randewoo.ru';
// A Unicode boundary is required: JavaScript's \b does not treat Cyrillic as letters.
export const VOLUME = /(?<![\d.,])1[.,]5\s*(?:мл|ml)(?![\p{L}\p{N}_])/iu;

export function productUrl(value) {
  if (typeof value !== 'string') throw new ValidationError('Нужна ссылка на товар https://randewoo.ru/product/…');
  value = value.trim();
  if (/[\\\r\n]/.test(value)) throw new ValidationError('Нужна ссылка на товар https://randewoo.ru/product/…');
  let url;
  try {url = new URL(value, ORIGIN);} catch {throw new ValidationError('Нужна ссылка на товар https://randewoo.ru/product/…');}
  // Check the raw authority as well: URL normalizes an explicit :443 port away.
  const authority = /^(?:https?:)?\/\/([^/?#]+)/i.exec(value)?.[1];
  if (url.origin !== ORIGIN || url.username || url.password || (authority && authority !== 'randewoo.ru') || !/^\/product\/[^/]+\/?$/.test(url.pathname)) {
    throw new ValidationError('Нужна ссылка на товар https://randewoo.ru/product/…');
  }
  return ORIGIN + url.pathname.replace(/\/+$/, '');
}

export function money(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new FetchError('Сайт вернул некорректную цену');
  const match = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(String(value));
  if (!match) throw new FetchError('Сайт вернул некорректную цену');
  const result = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0) throw new FetchError('Сайт вернул некорректную цену');
  return result;
}

function* objects(value) {
  if (value && typeof value === 'object') {
    if (!Array.isArray(value)) yield value;
    for (const child of Object.values(value)) yield* objects(child);
  }
}

const hasType = (node, type) => [node?.['@type']].flat().includes(type);

export function parseProducts(html, url) {
  url = productUrl(url);
  const $ = load(html);
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {nodes.push(...objects(JSON.parse($(element).text())));} catch { /* Ignore unrelated invalid metadata. */ }
  });
  const products = nodes.filter(node => hasType(node, 'Product'));
  const matchesUrl = value => {
    if (typeof value === 'object') value = value?.['@id'];
    if (typeof value !== 'string') return false;
    try {return productUrl(new URL(value, url).href) === url;} catch {return false;}
  };
  const parent = products.find(node => [node.url, node['@id'], node.mainEntityOfPage].some(matchesUrl))
    || products.find(node => !node.url && !node['@id']);
  if (!parent) throw new FetchError('Не удалось распознать карточку товара');
  const references = new Map();
  for (const node of nodes) if (node['@id'] && Object.keys(node).length > Object.keys(references.get(node['@id']) || {}).length) references.set(node['@id'], node);
  function* ownOffers(value, visited = new Set()) {
    if (Array.isArray(value)) {for (const child of value) yield* ownOffers(child, visited); return;}
    if (!value || typeof value !== 'object') return;
    value = references.get(value['@id']) || value;
    if (visited.has(value)) return;
    visited.add(value);
    if (hasType(value, 'Offer')) yield value;
    else yield* ownOffers(value.offers, visited);
  }
  const brand = typeof parent?.brand === 'object' ? parent.brand?.name || '' : String(parent?.brand || '');
  let title = parent?.name || '';
  if (brand && title.startsWith(brand)) title = title.slice(brand.length).trim();
  const cards = new Map($('li[data-product-sku][data-variant]').toArray().map(element => [$(element).attr('data-product-sku'), element]));
  const offers = new Map([...ownOffers(parent.offers)].filter(node => node.sku != null && VOLUME.test(node.name || '')).map(offer => [String(offer.sku), offer]));
  const image = $('meta[property="og:image"]').first().attr('content') || '';
  const result = [];
  for (const [sku, offer] of offers) {
    if (offer.priceCurrency !== 'RUB') throw new FetchError('Сайт вернул цену в другой валюте');
    const card = $(cards.get(sku));
    result.push({sku, brand: brand || card.attr('data-brand') || '', name: title || card.attr('data-name') || offer.name,
      url: productUrl(url), variant: card.attr('data-variant') || offer.name, volume_ml: '1.5',
      price_kopecks: money(offer.price), original_price_kopecks: null,
      in_stock: String(offer.availability || '').endsWith('/InStock'), image, status: 'ok'});
  }
  if (result.length) return result;
  return [{sku: null, brand, name: title, url: productUrl(url), variant: 'Вариант 1,5 мл не найден', volume_ml: '1.5',
    price_kopecks: null, original_price_kopecks: null, in_stock: false, image, status: 'missing'}];
}

export function parseFavorites(html) {
  const $ = load(html), items = [], pages = new Set();
  $('.b-cabinetProductList__productsItem').each((_, element) => {
    const card = $(element), href = card.find('a[href^="/product/"]').first().attr('href');
    const parentId = Number(card.find('[data-product-id]').first().attr('data-product-id'));
    if (href && Number.isSafeInteger(parentId) && parentId > 0) items.push({url: productUrl(href), parent_id: parentId,
      brand: card.find('.s-productItem__brand').text().trim(), name: card.find('.s-productItem__titleLink').text().trim(),
      image: card.find('img').first().attr('src') || ''});
  });
  $('a[href^="/cabinet/favorites?"]').each((_, element) => {
    const value = new URL($(element).attr('href'), ORIGIN).searchParams.get('page');
    if (/^\d+$/.test(value || '') && Number(value) > 0) pages.add(Number(value));
  });
  return {items, pages};
}

export function authorizedUser(html) {
  const match = /gon\.user\s*=\s*/.exec(html);
  let user;
  if (match) {
    // Read one JSON object without evaluating any website JavaScript.
    const rest = html.slice(match.index + match[0].length);
    let depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < rest.length; i++) {
      const char = rest[i];
      if (quoted) {if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false;}
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {try {user = JSON.parse(rest.slice(0, i + 1));} catch {} break;}
    }
  }
  if (user?.is_authorized !== true) throw new AuthError('Сессия истекла: обновите вход в Randewoo');
  return {favorites_count: user.favorite_products_count};
}

export class Randewoo {
  constructor(sessionPath, options = {}) {this.sessionPath = sessionPath; this.transport = new CurlTransport(options); this.closed = false;}
  close() {this.closed = true; this.transport.close();}

  session() {
    try {
      const session = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
      if (!session.cookie || !session.user_agent) throw new Error();
      quote(session.cookie); quote(session.user_agent);
      return session;
    } catch {throw new AuthError('Добавьте действующую сессию Randewoo в настройках');}
  }

  async get(path, {authorized = false, json = false} = {}) {
    if (this.closed) throw new FetchError('Приложение останавливается');
    const {status, payload} = await this.transport.request(path, {json, session: authorized ? this.session() : undefined, checkId: this.checkId});
    if (status !== 200) {
      if (authorized && [301, 302, 303, 401].includes(status)) throw new AuthError('Сессия истекла: обновите вход в Randewoo');
      throw new FetchError('Randewoo вернул HTTP ' + (status || 'неизвестен'));
    }
    if (!json) return payload;
    try {return JSON.parse(payload);} catch {throw new FetchError('Неожиданный формат ответа Randewoo');}
  }

  async authorizedUser() {return authorizedUser(await this.get('/cart', {authorized: true}));}

  async cart() {
    const data = await this.get('/front_api/cart/new_cart', {authorized: true, json: true});
    if (!Array.isArray(data?.items)) throw new FetchError('Не удалось распознать корзину; предыдущий список сохранён');
    return data.items.map(item => {
      try {
        const p = item.product;
        if (!p || p.sku == null || typeof p.subtitle !== 'string' || !Number.isSafeInteger(item.count) || item.count < 1 || typeof p.can_buy !== 'boolean') throw new Error();
        return {url: productUrl(p.href), sku: String(p.sku), brand: p.brand_title, name: p.title, variant: p.subtitle,
          quantity: item.count, matches_target_volume: VOLUME.test(p.subtitle), price_kopecks: money(p.price),
          original_price_kopecks: p.price_original == null ? null : money(p.price_original), in_stock: p.can_buy};
      } catch {throw new FetchError('Изменился формат товара корзины; список сохранён');}
    });
  }

  async favorites() {
    const stats = await this.get('/favorites', {authorized: true, json: true});
    if (!Array.isArray(stats?.ids) || stats.ids.some(id => !Number.isSafeInteger(id))) throw new FetchError('Не удалось распознать избранное; предыдущий список сохранён');
    const expected = new Set(stats.ids), results = new Map(), pending = new Set([1]), visited = new Set();
    while (pending.size) {
      const number = Math.min(...pending); pending.delete(number);
      if (visited.has(number)) continue;
      if (number > 100 || visited.size >= 100) throw new FetchError('Слишком много страниц избранного');
      const page = parseFavorites(await this.get('/cabinet/favorites' + (number > 1 ? '?page=' + number : ''), {authorized: true}));
      visited.add(number);
      for (const item of page.items) if (expected.has(item.parent_id)) results.set(item.parent_id, item);
      for (const pageNumber of page.pages) if (!visited.has(pageNumber)) pending.add(pageNumber);
    }
    if (results.size !== expected.size) throw new FetchError('Избранное получено не полностью; предыдущий список сохранён');
    return [...results.values()];
  }

  async products(url) {
    url = productUrl(url);
    return parseProducts(await this.get(new URL(url).pathname), url);
  }
}
