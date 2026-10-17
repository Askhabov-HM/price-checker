import {ValidationError} from '../../errors.js';
import {OZON_ORIGIN, ozonProduct} from './url.js';

const invalid = () => new ValidationError('Не удалось подтвердить структуру ответа Ozon.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value.trim().length <= 2000 ? value.trim() : null;
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;

function widgets(data, prefix) {
  if (!object(data?.widgetStates)) throw invalid();
  return Object.entries(data.widgetStates).filter(([key]) => key.startsWith(prefix + '-')).map(([key, raw]) => {
    let value = raw;
    try {if (typeof raw === 'string') value = JSON.parse(raw);} catch {throw invalid();}
    if (!object(value)) throw invalid();
    return {key, value};
  });
}

// Integer kopecks, including Ozon's thin-space thousands separators. Missing prices stay null.
export function rublePrice(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,3}(?:[ \u00a0\u2009\u202f]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(?:₽|руб\.?)$/iu.exec(value.trim());
  if (!match) return null;
  const kopecks = Number(match[1].replace(/[ \u00a0\u2009\u202f]/g, '')) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(kopecks) && kopecks > 0 ? kopecks : null;
}

function productIdentity(sku, link, allowMissingLink = false) {
  const external_id = id(sku);
  if (!external_id) throw invalid();
  // Removed favorites can retain their exact SKU while Ozon omits the clickable card link.
  if (allowMissingLink && link == null) return {external_id, url: OZON_ORIGIN + '/product/' + external_id + '/'};
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//')) throw invalid();
  let product;
  try {product = ozonProduct(OZON_ORIGIN + link);} catch {throw invalid();}
  if (product.external_id !== external_id) throw invalid();
  return product;
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'ir.ozone.ru' && !url.username && !url.password && !url.port ? url.href : null;
  } catch {return null;}
}

function favorite(item) {
  if (!object(item)) throw invalid();
  const toggles = array(item.topRightButtons).filter(button => button?.favoriteProductMoleculeV2).map(button => button.favoriteProductMoleculeV2);
  if (!toggles.some(toggle => toggle.isFav === true)) return null;
  const product = productIdentity(item.sku, item.action?.link, true);
  if (id(item.id) !== product.external_id || toggles.some(toggle => toggle.isFav === false)) throw invalid();
  const title = text(array(item.mainState).find(part => part?.id === 'name')?.textDS?.text);
  if (!title) throw invalid();
  const price = array(item.mainState).find(part => part?.type === 'priceV2')?.priceV2;
  const badge = text(item.tileImage?.leftBottomBadgeV2?.text);
  return {...product, title, image_url: imageUrl(array(item.tileImage?.items).find(part => part?.image)?.image?.link),
    availability: item.action?.link == null ? 'unavailable' : badge === 'Нет в наличии' ? 'out_of_stock' : 'unknown',
    listed_price_kopecks: rublePrice(array(price?.price).find(part => part?.textStyle === 'PRICE')?.text)};
}

function favoritesNext(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) throw invalid();
  const url = new URL(value, OZON_ORIGIN);
  if (url.origin !== OZON_ORIGIN || url.pathname !== '/my/favorites' || url.hash
    || [...url.searchParams.keys()].some(key => /list|wishlist/i.test(key))
    || url.searchParams.has('layout_container') && url.searchParams.get('layout_container') !== 'default') throw invalid();
  return url.pathname + url.search;
}

export function parseFavoritesPage(data) {
  const grids = widgets(data, 'tileGridDesktop').filter(({key}) => /^tileGridDesktop-\d+-default-\d+$/.test(key));
  if (!grids.length) throw invalid();
  const items = grids.flatMap(({value}) => {
    if (!Array.isArray(value.items)) throw invalid();
    return value.items.map(favorite).filter(Boolean);
  });
  const selected = widgets(data, 'searchResultsSort').flatMap(({value}) => array(value.sortButton?.options)).filter(option => option?.isSelected === true);
  let sorting = null;
  if (selected.length === 1 && typeof selected[0].action?.link === 'string') {
    const url = new URL(selected[0].action.link, OZON_ORIGIN);
    if (url.origin === OZON_ORIGIN && url.pathname === '/my/favorites') sorting = url.searchParams.get('sorting');
  }
  // The other paginator belongs to Ozon recommendations; it is deliberately not followed.
  const paginator = widgets(data, 'infiniteVirtualPaginator')[0]?.value;
  const pagination_known = paginator ? Object.hasOwn(paginator, 'nextPage') : Object.hasOwn(data, 'nextPage');
  return {items, sorting, next_page: favoritesNext(paginator ? paginator.nextPage : data.nextPage), pagination_known};
}

export function latestFavorites(pages, limit = 30) {
  if (!Array.isArray(pages) || !pages.length || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const items = [], seen = new Set();
  let last;
  for (const [index, data] of pages.entries()) {
    const page = parseFavoritesPage(data);
    if (index === 0 && page.sorting !== 'last_added' || index > 0 && page.sorting && page.sorting !== 'last_added') throw invalid();
    last = page;
    for (const item of page.items) {
      if (seen.has(item.external_id)) continue;
      seen.add(item.external_id); items.push(item);
      if (items.length === limit) return {items, limit, complete: true};
    }
    if (page.pagination_known && !page.next_page) return {items, limit, complete: true};
  }
  return {items, limit, complete: false, next_page: last.next_page};
}

export function parseCartPage(data) {
  const groups = widgets(data, 'cartSplit');
  const items = groups.flatMap(({value}) => {
    if (!Array.isArray(value.cartItems)) throw invalid();
    return value.cartItems.map(row => {
      if (!object(row)) throw invalid();
      const product = productIdentity(row.product?.id, row.product?.common?.action?.link);
      const quantity = row.controls?.quantity?.current;
      const labels = array(row.product.titleColumn).filter(part => part?.type === 'text').map(part => text(part.text?.text)).filter(Boolean);
      if (!labels?.length || !Number.isSafeInteger(quantity) || quantity < 1) throw invalid();
      const prices = array(row.product.priceColumn).flatMap(column => array(column?.prices?.elements));
      const price = style => rublePrice(array(prices.find(part => part?.priceStyle?.styleType === style)?.price).find(part => part?.textStyle === 'PRICE')?.text);
      return {...product, title: labels[0], variant_label: labels[1] || null, quantity,
        image_url: imageUrl(row.product.image?.image?.url), availability: 'unknown',
        prices: {bank_kopecks: price('CARD_PRICE'), regular_kopecks: price('SECOND_LVL'), ozon_card_kopecks: null}};
    });
  });
  if (new Set(items.map(item => item.external_id)).size !== items.length) throw invalid();
  const summary = widgets(data, 'master')[0]?.value.summary;
  if (!Array.isArray(summary) || summary.length !== items.length
    || new Set(summary.map(row => id(row?.id))).size !== items.length
    || summary.some(row => !id(row?.quantity) || !items.some(item => item.external_id === id(row.id) && item.quantity === Number(row.quantity)))) throw invalid();
  return {items, complete: true};
}

export function parseProductPage(data, externalId, bankConditions = null) {
  if (!id(externalId)) throw invalid();
  const productId = widgets(data, 'webDetailSKU')[0]?.value.copyText;
  const price = widgets(data, 'webPrice')[0]?.value;
  const title = text(widgets(data, 'webProductHeading')[0]?.value.title);
  if (id(productId) !== String(externalId) || !title || !price || typeof price.isAvailable !== 'boolean') throw invalid();
  const bank = price.isAvailable ? rublePrice(price.cardPrice) : null;
  const regular = price.isAvailable ? rublePrice(price.price) : null;
  if (price.isAvailable && bank === null && regular === null) throw invalid();
  const label = text(price.lexemes?.withOzonCard);
  let ozonCardVerified = Boolean(label && /(?:ozon|озон)\s*карт/iu.test(label));
  if (bankConditions && id(bankConditions.external_id) === String(externalId)) {
    const banks = widgets(bankConditions.data, 'cellList').flatMap(({value}) => array(value.cells))
      .map(cell => cell.dsCell?.centerBlock?.title?.text);
    ozonCardVerified ||= banks.some(name => typeof name === 'string' && /^ozon\s+банк$/iu.test(name.trim()));
  }
  const seller = widgets(data, 'webCurrentSeller')[0]?.value;
  // Read the IDs carried by the subscription controls, without ever invoking those controls.
  const sellerIds = [...new Set(['subscribed', 'unsubscribed'].map(key => id(seller?.header?.badge?.[key]?.common?.action?.params?.sellerId)).filter(Boolean))];
  const sellerId = sellerIds.length === 1 ? sellerIds[0] : null;
  let sellerUrl = null;
  try {
    const url = new URL(seller?.sellerCell?.common?.action?.link, OZON_ORIGIN);
    if (url.origin === OZON_ORIGIN && /^\/seller\/[^/]+\/$/.test(url.pathname) && !url.username && !url.password) sellerUrl = url.origin + url.pathname;
  } catch { /* An unknown seller is not evidence of a seller change. */ }
  return {external_id: String(externalId), url: OZON_ORIGIN + '/product/' + externalId + '/', title,
    availability: price.isAvailable ? 'available' : 'out_of_stock',
    seller: {external_id: sellerId, name: text(seller?.sellerCell?.centerBlock?.title?.text), url: sellerUrl},
    prices: {bank_kopecks: bank, regular_kopecks: regular, ozon_card_kopecks: ozonCardVerified ? bank : null,
      original_kopecks: price.isAvailable ? rublePrice(price.originalPrice) : null},
    payment: {bank_label: label, regular_label: text(price.lexemes?.withoutOzonCard), ozon_card_verified: ozonCardVerified}};
}
