import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {rublePrice, parseFavoritesPage, latestFavorites, parseCartPage, parseProductPage} from '../src/providers/ozon/parser.js';
import {readSnapshot} from '../src/providers/ozon/snapshot.js';
import {temporary} from './helpers.js';

const page = entries => ({widgetStates: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))});
const tile = (sku, isFav = true) => ({id: String(sku), sku, action: {link: '/product/item-' + sku + '/?at=private-tracking'},
  topRightButtons: [{favoriteProductMoleculeV2: {isFav}}],
  mainState: [{type: 'priceV2', priceV2: {price: [{textStyle: 'PRICE', text: '1\u2009234\u2009₽'}, {textStyle: 'ORIGINAL_PRICE', text: '9 999 ₽'}]}},
    {id: 'name', textDS: {text: 'Test product ' + sku}}]});
const sort = sorting => ({sortButton: {options: [{isSelected: true, action: {link: '/my/favorites?sorting=' + sorting}}]}});
const favoritesPage = (items, extra = {}) => page({'tileGridDesktop-12-default-1': {items}, 'searchResultsSort-3-default-1': sort('last_added'), ...extra});
const productPage = (price = {}, seller = {}) => page({
  'webDetailSKU-1-default-1': {copyText: '123'},
  'webProductHeading-2-default-1': {title: 'Test product'},
  'webPrice-3-default-1': {isAvailable: true, cardPrice: '900 ₽', price: '1 000 ₽', originalPrice: '2 000 ₽',
    lexemes: {withOzonCard: 'С банками', withoutOzonCard: 'С другими банками'}, ...price},
  'webCurrentSeller-4-default-1': {header: {badge: {subscribed: {common: {action: {params: {sellerId: '55'}}}},
    unsubscribed: {common: {action: {params: {sellerId: '55'}}}}}},
    sellerCell: {centerBlock: {title: {text: 'Test seller'}}, common: {action: {link: 'https://www.ozon.ru/seller/test-seller/'}}}, ...seller},
});
const banks = (name = 'Ozon Банк', external_id = '123') => ({external_id,
  data: page({'cellList-1-default-1': {cells: [{dsCell: {centerBlock: {title: {text: name}}}}]}})});

test('RUB parsing preserves kopecks, validates grouping, and never turns unavailable or foreign prices into zero', () => {
  assert.equal(rublePrice('12\u202f345,67 ₽'), 1234567);
  assert.equal(rublePrice('1\u2009234\u2009₽'), 123400);
  assert.equal(rublePrice('1 234.5 руб.'), 123450);
  for (const value of [null, 123, '0 ₽', '-100 ₽', '1 23 ₽', '1,234 ₽', '100 $', 'от 100 ₽', 'нет в наличии', '999999999999999999 ₽']) {
    assert.equal(rublePrice(value), null, String(value));
  }
});

test('favorites keep only true memberships and ignore the separate recommendation grid even for an already favorited recommendation', () => {
  const data = favoritesPage([tile(123), tile(456, false)], {'tileGridDesktop-99-recoms_pagination_favorites_web-1': {items: [tile(789)]}});
  const parsed = parseFavoritesPage(data);
  assert.deepEqual(parsed.items.map(item => item.external_id), ['123']);
  assert.equal(parsed.items[0].listed_price_kopecks, 123400);
  assert.equal(parsed.items[0].url, 'https://www.ozon.ru/product/item-123/');
  assert.equal(parsed.items[0].prices, undefined);
  assert.doesNotMatch(JSON.stringify(parsed), /private-tracking|9 999/);
});

test('unavailable and removed favorites retain their original SKU and position', () => {
  const unavailable = tile(123); unavailable.tileImage = {leftBottomBadgeV2: {text: 'Нет в наличии'}};
  const removed = tile(456); delete removed.action;
  removed.mainState = [{id: 'name', textDS: {text: 'Недоступно к покупке'}}];
  const items = latestFavorites([favoritesPage([unavailable, removed])], 2).items;
  assert.equal(items[0].availability, 'out_of_stock');
  assert.equal(items[1].availability, 'unavailable');
  assert.equal(items[1].url, 'https://www.ozon.ru/product/456/');
  assert.equal(items[1].listed_price_kopecks, null);
});

test('a different SKU or a foreign link is not accepted as the tracked variant', () => {
  const wrongVariant = tile(123); wrongVariant.action.link = '/product/456/';
  assert.throws(() => parseFavoritesPage(favoritesPage([wrongVariant])), /структуру/);
  const wrongDomain = tile(123); wrongDomain.action.link = '//evil.test/product/123/';
  assert.throws(() => parseFavoritesPage(favoritesPage([wrongDomain])), /структуру/);
  const wrongId = tile(123); wrongId.id = '456';
  assert.throws(() => parseFavoritesPage(favoritesPage([wrongId])), /структуру/);
});

test('only the favorites paginator is followed; recommendation pagination cannot become an account list', () => {
  const data = favoritesPage([tile(123)], {
    'paginator-2-default-1': {nextPage: '/my/favorites?layout_container=recoms_pagination_favorites_web'},
    'infiniteVirtualPaginator-3-default-1': {nextPage: '/my/favorites?layout_page_index=2&page=cursor'},
  });
  assert.equal(parseFavoritesPage(data).next_page, '/my/favorites?layout_page_index=2&page=cursor');
  for (const target of ['//evil.test/my/favorites', '/my/favorites?layout_container=recoms', '/my/favorites?list=123', '/cart']) {
    assert.throws(() => parseFavoritesPage(favoritesPage([tile(123)], {'infiniteVirtualPaginator-3-default-1': {nextPage: target}})), /структуру/);
  }
});

test('latest selection is capped at thirty, preserves order and deduplicates across pages', () => {
  const first = favoritesPage(Array.from({length: 20}, (_, n) => tile(100 + n)), {
    'infiniteVirtualPaginator-3-default-1': {nextPage: '/my/favorites?layout_page_index=2'},
  });
  const second = page({'tileGridDesktop-12-default-2': {items: Array.from({length: 20}, (_, n) => tile(115 + n))}});
  const result = latestFavorites([first, second]);
  assert.equal(result.complete, true); assert.equal(result.items.length, 30);
  assert.deepEqual(result.items.map(item => item.external_id), Array.from({length: 30}, (_, n) => String(100 + n)));
});

test('partial, unknown and differently sorted responses cannot masquerade as a completed latest selection', () => {
  assert.equal(latestFavorites([favoritesPage([tile(123)])]).complete, false);
  assert.throws(() => latestFavorites([favoritesPage([tile(123)], {'searchResultsSort-3-default-1': sort('first_added')})]), /структуру/);
  assert.throws(() => parseFavoritesPage({widgetStates: {'login-1-default-1': '{}'}, nextPage: ''}), /структуру/);
  const empty = favoritesPage([]); empty.nextPage = '';
  assert.deepEqual(latestFavorites([empty]), {items: [], limit: 30, complete: true});
  const unknownPaginator = favoritesPage([tile(123)], {'infiniteVirtualPaginator-3-default-1': {}}); unknownPaginator.nextPage = '';
  assert.equal(latestFavorites([unknownPaginator]).complete, false);
});

function cartPage() {
  const price = (styleType, value) => ({prices: {elements: [{priceStyle: {styleType}, price: [{textStyle: 'PRICE', text: value}]}]}});
  return page({'cartSplit-1-default-1': {cartItems: [{controls: {quantity: {current: 2}}, product: {
    id: '123', common: {action: {link: '/product/123/'}},
    titleColumn: [{type: 'text', text: {text: 'Test product'}}, {type: 'text', text: {text: 'Size 52, blue'}}],
    priceColumn: [price('CARD_PRICE', '900 ₽'), price('SECOND_LVL', '1 000 ₽')],
  }}]}, 'master-2-default-1': {summary: [{id: '123', quantity: '2'}]}});
}

test('cart keeps quantity and variant, distinguishes its two prices, and does not assert an unverified Ozon Card condition', () => {
  const result = parseCartPage(cartPage());
  assert.equal(result.complete, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].variant_label, 'Size 52, blue');
  assert.deepEqual(result.items[0].prices, {bank_kopecks: 90000, regular_kopecks: 100000, ozon_card_kopecks: null});
});

test('an incomplete cart, mismatched quantities or repeated SKU are rejected before synchronization', () => {
  const data = cartPage(); data.widgetStates['master-2-default-1'] = JSON.stringify({summary: [{id: '123', quantity: '3'}]});
  assert.throws(() => parseCartPage(data), /структуру/);
  const missing = cartPage(); delete missing.widgetStates['master-2-default-1'];
  assert.throws(() => parseCartPage(missing), /структуру/);
  const duplicate = cartPage(), group = JSON.parse(duplicate.widgetStates['cartSplit-1-default-1']); group.cartItems.push(group.cartItems[0]);
  duplicate.widgetStates['cartSplit-1-default-1'] = JSON.stringify(group);
  assert.throws(() => parseCartPage(duplicate), /структуру/);
});

test('the product card separates bank, regular and old prices; the field name cardPrice alone is not Ozon Card proof', () => {
  const result = parseProductPage(productPage(), '123');
  assert.deepEqual(result.prices, {bank_kopecks: 90000, regular_kopecks: 100000, original_kopecks: 200000, ozon_card_kopecks: null});
  assert.equal(result.payment.ozon_card_verified, false);
  assert.equal(result.seller.external_id, '55');
  assert.equal(result.seller.name, 'Test seller');
});

test('Ozon Card is verified by an explicit label or the same product bank conditions, not another product or unrelated bank', () => {
  assert.equal(parseProductPage(productPage(), '123', banks()).prices.ozon_card_kopecks, 90000);
  assert.equal(parseProductPage(productPage(), '123', banks('Another bank')).prices.ozon_card_kopecks, null);
  assert.equal(parseProductPage(productPage(), '123', banks('Ozon Банк', '456')).prices.ozon_card_kopecks, null);
  assert.equal(parseProductPage(productPage({lexemes: {withOzonCard: 'С Ozon Картой'}}), '123').prices.ozon_card_kopecks, 90000);
});

test('variant substitution and unavailable cards never create a false current price', () => {
  assert.throws(() => parseProductPage(productPage(), '456'), /структуру/);
  const unavailable = parseProductPage(productPage({isAvailable: false}), '123', banks());
  assert.equal(unavailable.availability, 'out_of_stock');
  assert.deepEqual(unavailable.prices, {bank_kopecks: null, regular_kopecks: null, ozon_card_kopecks: null, original_kopecks: null});
  assert.throws(() => parseProductPage(productPage({cardPrice: 'unknown', price: 'unknown'}), '123'), /структуру/);
});

test('a seller rename retains the stable ID; conflicting or missing IDs remain unknown', () => {
  const renamed = productPage(); const seller = JSON.parse(renamed.widgetStates['webCurrentSeller-4-default-1']);
  seller.sellerCell.centerBlock.title.text = 'Renamed shop'; renamed.widgetStates['webCurrentSeller-4-default-1'] = JSON.stringify(seller);
  assert.equal(parseProductPage(renamed, '123').seller.external_id, '55');
  seller.header.badge.unsubscribed.common.action.params.sellerId = '99';
  renamed.widgetStates['webCurrentSeller-4-default-1'] = JSON.stringify(seller);
  assert.equal(parseProductPage(renamed, '123').seller.external_id, null);
  assert.equal(parseProductPage(productPage({}, {header: {}}), '123').seller.external_id, null);
});

test('an offline MCP snapshot validates source identity and confines response files to its directory', t => {
  const root = temporary(t), path = join(root, 'capture.json');
  writeFileSync(join(root, 'favorites.network-response'), JSON.stringify(favoritesPage([tile(123)])));
  writeFileSync(join(root, 'cart.network-response'), JSON.stringify(cartPage()));
  const manifest = {provider: 'ozon-capture', version: 1, favorites: {files: ['favorites.network-response'], limit: 1}, cart: 'cart.network-response'};
  writeFileSync(path, JSON.stringify(manifest));
  const result = readSnapshot(path);
  assert.equal(result.live, false); assert.equal(result.network_requests_made, 0);
  assert.equal(result.favorites.items.length, 1); assert.equal(result.cart.items.length, 1);
  writeFileSync(path, JSON.stringify({...manifest, provider: 'randewoo'}));
  assert.throws(() => readSnapshot(path), /ozon-capture/);
  writeFileSync(path, JSON.stringify({...manifest, favorites: {files: ['../foreign.network-response']}}));
  assert.throws(() => readSnapshot(path), /ozon-capture/);
});
