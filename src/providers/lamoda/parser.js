import {load} from 'cheerio';

const messages = {
  login_required:'Нужен повторный вход в Lamoda.', account_mismatch:'Открыт другой аккаунт Lamoda.',
  account_unverified:'Не удалось подтвердить аккаунт Lamoda.', incomplete_data:'Получен неполный список Lamoda. Предыдущие данные сохранены.',
  invalid_data:'Не удалось подтвердить данные Lamoda. Предыдущие данные сохранены.',
  access_limited:'Lamoda временно ограничила доступ.', rate_limited:'Lamoda попросила снизить частоту запросов.',
  browser_unavailable:'Браузер Lamoda временно недоступен.', interrupted:'Проверка Lamoda прервана.',
};
export class LamodaError extends Error {
  constructor(code, retryAfterMs = 0, httpStatus = null) {
    super(messages[code] || messages.invalid_data);
    this.code = code; this.retry_after_ms = retryAfterMs; this.http_status = httpStatus;
  }
}
export const validSku = value => typeof value === 'string' && /^[A-Z0-9]{6,32}$/.test(value);
const invalid = () => new LamodaError('invalid_data');

export function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw invalid();
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(result)) throw invalid();
  return result;
}

// Lamoda's wishlist response embeds each state member as JSON on its own line.
// Parse only the two observed JSON members, never execute the site's scripts.
export function wishlistStateHtml(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 12*1024*1024) throw invalid();
  const $ = load(html);
  const scripts = $('script').toArray().map(node => $(node).text()).filter(text => /^\s*var\s+__NUXT__\s*=/.test(text));
  if (scripts.length !== 1) throw new LamodaError('account_unverified');
  const read = key => {
    const lines = scripts[0].split('\n').filter(line => new RegExp('^ {8}'+key+':').test(line));
    if (lines.length !== 1) throw invalid();
    try {return JSON.parse(lines[0].replace(new RegExp('^ {8}'+key+':\\s*'),'').replace(/,\s*$/,''));}
    catch {throw invalid();}
  };
  const user = read('user');
  if (user && Object.hasOwn(user,'customer') && user.customer === null) throw new LamodaError('login_required');
  return {user,payload:read('payload')};
}

export function parseWishlistHtml(html) {
  const {user,payload} = wishlistStateHtml(html);
  return parseWishlistState(user,payload);
}

export function minimalWishlistState(user,payload) {
  parseWishlistState(user,payload);
  const keys = ['sku','name','price_iso_code','seo_tail','prices','price_amount','old_price_amount',
    'is_available','is_sellable','thumbnail','color_family','is_hybrid','hybrid_products'];
  const pagination = payload?.pagination;
  const state = {
    user:{customer:user?.customer ? {id:user.customer.id,is_active:user.customer.is_active} : null,
      wishlist:user?.wishlist?.map(item => ({product_sku:item.product_sku,
        ...(item.adjacent_skus == null ? {} : {adjacent_skus:item.adjacent_skus})}))},
    payload:{pagination:pagination && Object.fromEntries(['found','limit','offset','page','pages'].map(key => [key,pagination[key]])),
      products:payload?.products?.map(product => ({
        ...Object.fromEntries(keys.filter(key => Object.hasOwn(product,key)).map(key => [key,key === 'prices' && Array.isArray(product.prices)
          ? product.prices.map(entry => ({price:entry?.price})) : product[key]])),
        brand:{name:product.brand?.name}}))},
  };
  parseWishlistState(state.user,state.payload);
  return state;
}

export function parseWishlistState(user, payload) {
  if (!user || typeof user !== 'object' || !Object.hasOwn(user,'customer')) throw new LamodaError('account_unverified');
  if (user.customer === null) throw new LamodaError('login_required');
  if (!Number.isSafeInteger(user.customer?.id) || user.customer.id <= 0 || user.customer.is_active !== true) throw new LamodaError('account_unverified');
  if (!Array.isArray(user.wishlist) || user.wishlist.length > 100000) throw invalid();
  const favorites = user.wishlist.map(item => item?.product_sku);
  if (favorites.some(sku => !validSku(sku)) || new Set(favorites).size !== favorites.length) throw invalid();
  // A wishlist entry can use a seller SKU while the displayed hybrid card uses
  // another SKU. Accept only explicit, reciprocal grouping supplied by Lamoda.
  const adjacent = new Map();
  for (const entry of user.wishlist) {
    if (entry.adjacent_skus == null) continue;
    const aliases = entry.adjacent_skus;
    if (!Array.isArray(aliases) || aliases.length > 100 || aliases.some(sku => !validSku(sku))
      || new Set(aliases).size !== aliases.length) throw invalid();
    for (const alias of aliases) {
      if (!adjacent.has(alias)) adjacent.set(alias,new Set());
      adjacent.get(alias).add(entry.product_sku);
    }
  }
  const identity = product => {
    if (!validSku(product?.sku)) throw invalid();
    if (favorites.includes(product.sku)) return product.sku;
    const group = product.hybrid_products;
    // Some seller cards omit is_hybrid while still supplying reciprocal SKU groups.
    // A missing marker is allowed; an explicit conflicting marker is not.
    if ((Object.hasOwn(product,'is_hybrid') && product.is_hybrid !== true) || !Array.isArray(group) || group.length > 100
      || group.some(sku => !validSku(sku)) || !group.includes(product.sku)) throw invalid();
    const matches = [...(adjacent.get(product.sku) || [])].filter(sku => group.includes(sku));
    if (matches.length !== 1) throw invalid();
    return matches[0];
  };
  const p = payload?.pagination;
  if (!p || ['found','limit','offset','page','pages'].some(key => !Number.isSafeInteger(p[key]))
    || p.found < 0 || p.found > 100000 || p.limit < 1 || p.limit > 1000 || p.page < 1 || p.pages < 0
    || p.offset !== (p.page-1)*p.limit || p.pages !== Math.ceil(p.found/p.limit)
    || p.page > Math.max(1,p.pages) || p.found !== favorites.length || !Array.isArray(payload.products)) throw new LamodaError('incomplete_data');
  const expected = Math.min(p.limit,Math.max(0,p.found-p.offset));
  if (payload.products.length !== expected) throw new LamodaError('incomplete_data');
  const items = payload.products.map(product => {
    const sku = identity(product);
    if (typeof product.name !== 'string'
      || !product.name.trim() || product.name.length > 1000 || product.price_iso_code !== 'RUB'
      || typeof product.brand?.name !== 'string' || product.brand.name.length > 500
      || typeof product.seo_tail !== 'string' || !/^[a-zA-Z0-9_-]{1,500}$/.test(product.seo_tail)) throw invalid();
    if (product.prices != null && !Array.isArray(product.prices)) throw invalid();
    const prices = product.prices || [];
    // The observed price chain ends at the price displayed in the wishlist,
    // including an automatically applied onsite promotion; no cart is read.
    const price = money(prices.length ? prices.at(-1)?.price : product.price_amount);
    const firstPrice = prices.length > 1 ? money(prices[0]?.price) : null;
    const originalCandidate = firstPrice !== null && firstPrice !== price ? firstPrice : money(product.old_price_amount);
    const original = originalCandidate === 0 || originalCandidate === price ? null : originalCandidate;
    const unavailable = product.is_available === false || product.is_sellable === false;
    const availability = unavailable ? 'unavailable' : product.is_available === true && product.is_sellable === true ? 'available' : 'unknown';
    const thumbnail = typeof product.thumbnail === 'string' && /^\/[A-Z0-9/_\.a-z-]+$/.test(product.thumbnail) ? product.thumbnail : null;
    return {sku,title:(product.brand.name+' '+product.name).trim(),color:typeof product.color_family === 'string' ? product.color_family.slice(0,100) : '',
      url:'https://www.lamoda.ru/p/'+product.sku.toLowerCase()+'/'+product.seo_tail+'/',
      image_url:thumbnail ? 'https://a.lmcdn.ru/img236x341'+thumbnail : null,price,original_price:original,availability};
  });
  if (new Set(items.map(item => item.sku)).size !== items.length) throw new LamodaError('incomplete_data');
  return {account_id:String(user.customer.id),favorites,pagination:p,items};
}

export async function readAllFavorites(readPage, {expectedAccount = null, signal} = {}) {
  let first, membership; const items = new Map();
  for (let page = 1; page <= 1000; page++) {
    if (signal?.aborted) throw new LamodaError('interrupted');
    const result = await readPage(page);
    if (!result || result.pagination?.page !== page || !Array.isArray(result.favorites) || !Array.isArray(result.items)) throw new LamodaError('incomplete_data');
    if (expectedAccount && result.account_id !== expectedAccount) throw new LamodaError('account_mismatch');
    if (!first) {first = result; membership = JSON.stringify([...result.favorites].sort());}
    if (result.account_id !== first.account_id || JSON.stringify([...result.favorites].sort()) !== membership
      || result.pagination.found !== first.pagination.found || result.pagination.limit !== first.pagination.limit
      || result.pagination.pages !== first.pagination.pages) throw new LamodaError('incomplete_data');
    for (const item of result.items) {
      if (items.has(item.sku)) throw new LamodaError('incomplete_data');
      items.set(item.sku,item);
    }
    if (page >= result.pagination.pages) {
      if (items.size !== first.favorites.length || first.favorites.some(sku => !items.has(sku))) throw new LamodaError('incomplete_data');
      return {account_id:first.account_id,items:first.favorites.map(sku => items.get(sku))};
    }
  }
  throw new LamodaError('incomplete_data');
}
