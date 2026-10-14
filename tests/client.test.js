import test from 'node:test';
import assert from 'node:assert/strict';
import {Randewoo, authorizedUser, money, parseFavorites, parseProducts, productUrl, quote} from '../src/client.js';
import {AuthError, FetchError, ValidationError} from '../src/errors.js';

const url = 'https://randewoo.ru/product/test-fragrance';
const document = offers => '<script type="application/ld+json">' + JSON.stringify({'@type': 'Product', name: 'Brand Fragrance', brand: {name: 'Brand'}, offers}) + '</script>';
const offer = (name, price = 100, sku = '123') => ({'@type': 'Offer', name, price, sku, priceCurrency: 'RUB', availability: 'https://schema.org/InStock'});

test('only exact 1.5 ml variants, including different concentrations, are collected', () => {
  const rows = parseProducts(document([offer('Brand туалетная вода 1,5мл', 100, '1'), offer('Brand духи 1.5 ml', 200, '2'),
    offer('Brand 15мл', 999, '3'), offer('Brand 11,5мл', 888, '4'), offer('Brand 1,5мл1', 777, '5')]), url);
  assert.deepEqual(rows.map(row => [row.sku, row.price_kopecks]), [['1', 10000], ['2', 20000]]);
});
test('HTML variant labels and images are preserved', () => {
  const html = document([offer('Brand 1,5мл')]) + '<li data-product-sku="123" data-variant="духи 1,5мл"></li><meta property="og:image" content="https://img.randewoo.ru/a.jpg">';
  const row = parseProducts(html, url)[0];
  assert.equal(row.variant, 'духи 1,5мл'); assert.equal(row.image, 'https://img.randewoo.ru/a.jpg');
});
test('missing volume is explicit and never zero or another size', () => {
  const row = parseProducts(document([offer('Brand 50мл')]), url)[0];
  assert.equal(row.status, 'missing'); assert.equal(row.price_kopecks, null);
  assert.throws(() => parseProducts('<html>Unavailable</html>', url), FetchError);
});
test('money uses integer kopecks and rejects malformed and unsafe values', () => {
  assert.equal(money('123.45'), 12345); assert.equal(money(9.99), 999); assert.equal(money('100.000'), 10000);
  for (const value of [0, -1, 'NaN', Infinity, true, null, '12.345', '', Number.MAX_VALUE]) assert.throws(() => money(value), FetchError);
});
test('foreign currency is rejected', () => {assert.throws(() => parseProducts(document([{...offer('Brand 1,5мл'), priceCurrency: 'USD'}]), url), FetchError);});
test('only offers belonging to the requested product are collected', () => {
  const html = '<script type="application/ld+json">' + JSON.stringify([
    {'@type': 'Product', url: '/product/recommendation', name: 'Other', brand: 'OtherBrand', offers: [offer('Other 1,5мл', 900, '999')]},
    {'@type': 'Product', url, name: 'Brand Fragrance', brand: 'Brand', offers: [offer('Fragrance 1,5мл', 100, '123')]}
  ]) + '</script>';
  const rows = parseProducts(html, url);
  assert.deepEqual(rows.map(row => [row.sku, row.brand, row.name, row.price_kopecks]), [['123', 'Brand', 'Fragrance', 10000]]);
  assert.throws(() => parseProducts(html, 'https://randewoo.ru/product/unknown'), FetchError);
});
test('recommendations cannot supply a missing volume for the main product', () => {
  const html = document([offer('Brand 50мл')]) + document([offer('Other 1,5мл', 900, '999')]);
  const rows = parseProducts(html, url);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'missing'); assert.equal(rows[0].price_kopecks, null);
});
test('graph references and aggregate offers stay scoped to the main product', () => {
  const html = '<script type="application/ld+json">' + JSON.stringify({'@graph': [
    {'@type': ['Product'], '@id': '#product', name: 'Brand Fragrance', brand: 'Brand', offers: {'@id': '#offers'}},
    {'@type': 'AggregateOffer', '@id': '#offers', offers: [{'@id': '#sample'}]},
    {...offer('Brand 1,5мл'), '@id': '#sample'},
    offer('Other 1,5мл', 900, '999')
  ]}) + '</script>';
  assert.deepEqual(parseProducts(html, url).map(row => row.sku), ['123']);
});
test('only canonical Randewoo product URLs are accepted', () => {
  assert.equal(productUrl('/product/icon?x=1#fragment'), 'https://randewoo.ru/product/icon');
  for (const value of ['https://evil.example/product/a', 'https://randewoo.ru@evil.example/product/a', 'file:///product/a', 'https://randewoo.ru:443/product/a', 'https://randewoo.ru/cart', null]) assert.throws(() => productUrl(value), ValidationError);
});
test('recommendations are excluded and pagination is discovered', () => {
  const page = parseFavorites('<div class="b-cabinetProductList__productsItem"><a class="s-productItem__brand">Brand</a><a class="s-productItem__titleLink" href="/product/a">Name &amp; More</a><button data-product-id="7"></button></div><div class="s-productItem"><a href="/product/recommendation">Other</a></div><a href="/cabinet/favorites?page=2">Next</a>');
  assert.equal(page.items.length, 1); assert.equal(page.items[0].name, 'Name & More'); assert.equal(page.items[0].parent_id, 7);
  assert.deepEqual([...page.pages], [2]);
});
test('authorization reads JSON safely without exposing account fields', () => {
  assert.deepEqual(authorizedUser('gon.user = {"is_authorized":true,"name":"braces } and \\" quote","favorite_products_count":3};'), {favorites_count: 3});
  for (const html of ['gon.user = {"is_authorized":false};', '<html>login</html>', 'gon.user = window.secret();']) assert.throws(() => authorizedUser(html), AuthError);
});
test('session headers cannot inject curl configuration', () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  for (const value of ['cookie\nurl = evil', 'agent\rfoo', '\0', null]) assert.throws(() => quote(value), ValidationError);
});
test('all favorite pages are required before replacing a list', async () => {
  const client = new Randewoo('unused');
  const paths = [];
  client.get = async path => {
    paths.push(path);
    if (path === '/favorites') return {ids: [7, 8]};
    const id = path.includes('page=2') ? 8 : 7;
    return `<div class="b-cabinetProductList__productsItem"><a href="/product/a${id}"></a><button data-product-id="${id}"></button></div>` + (id === 7 ? '<a href="/cabinet/favorites?page=2">Next</a>' : '');
  };
  assert.equal((await client.favorites()).length, 2); assert.ok(paths.includes('/cabinet/favorites?page=2'));
  client.get = async path => path === '/favorites' ? {ids: [7]} : '<html>no cards</html>';
  await assert.rejects(client.favorites(), FetchError);
});
