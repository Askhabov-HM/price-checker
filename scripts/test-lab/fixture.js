import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Randewoo} from '../../src/client.js';
import {FetchError} from '../../src/errors.js';
import {Tracker} from '../../src/service.js';
import {makeServer, listen} from '../../src/web.js';
import {acquireInstance} from '../../src/instance.js';

export const PRODUCT_URL = 'https://randewoo.ru/product/test-lab-graph-eau';
export const SCENARIOS = Object.freeze({
  initial: {label: 'Первая цена', public: 100000, cart: 90000},
  drop: {label: 'Снижение', public: 80000, cart: 70000},
  rise: {label: 'Рост', public: 120000, cart: 110000},
  unchanged: {label: 'Без изменений', public: 120000, cart: 110000},
  unavailable: {label: 'Нет в наличии', public: 120000, cart: 110000, unavailable: true},
  recovery: {label: 'Снова в наличии', public: 95000, cart: 85000},
  error: {label: 'Ошибка источника', public: 95000, cart: 85000, error: true},
  restored: {label: 'Источник восстановлен', public: 95000, cart: 85000}
});

export function openSource(root) {
  mkdirSync(root, {recursive: true});
  const db = new DatabaseSync(join(root, 'source.sqlite3'), {timeout: 5000});
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS variants(sku TEXT PRIMARY KEY,label TEXT NOT NULL,public_price INTEGER NOT NULL,
      cart_price INTEGER NOT NULL,in_stock INTEGER NOT NULL,quantity INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),scenario TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,path TEXT NOT NULL,scenario TEXT NOT NULL,checked_at TEXT NOT NULL);
    INSERT OR IGNORE INTO variants VALUES('TEST-EDP-15','парфюмерная вода 1,5мл',100000,90000,1,2);
    INSERT OR IGNORE INTO variants VALUES('TEST-EDT-15','туалетная вода 1,5мл',60000,55000,1,1);
    INSERT OR IGNORE INTO variants VALUES('TEST-50','парфюмерная вода 50мл',999900,899900,1,1);
    INSERT OR IGNORE INTO state VALUES(1,'initial');`);
  return db;
}

export function setScenario(db, name) {
  if (!Object.hasOwn(SCENARIOS, name)) throw new Error('Unknown test scenario: ' + name);
  const scenario = SCENARIOS[name];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE variants SET public_price=?,cart_price=?,in_stock=? WHERE sku='TEST-EDP-15'")
      .run(scenario.public, scenario.cart, Number(!scenario.unavailable));
    db.prepare('UPDATE state SET scenario=? WHERE id=1').run(name);
    db.exec('COMMIT');
  } catch (error) {db.exec('ROLLBACK'); throw error;}
}

function fixtureServer(db) {
  return createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const scenario = db.prepare('SELECT scenario FROM state WHERE id=1').get().scenario;
    db.prepare('INSERT INTO requests(path,scenario,checked_at) VALUES(?,?,?)').run(path, scenario, new Date().toISOString());
    const rows = db.prepare('SELECT * FROM variants ORDER BY sku').all();
    let body, type = 'text/html; charset=utf-8', code = 200;
    if (path === '/cart') body = '<script>gon.user = {"is_authorized":true,"favorite_products_count":1};</script>';
    else if (path === '/favorites') {type = 'application/json'; body = JSON.stringify({ids: [7]});}
    else if (path === '/cabinet/favorites') body = `<div class="b-cabinetProductList__productsItem">
      <a class="s-productItem__brand">Test Lab</a><a class="s-productItem__titleLink" href="${new URL(PRODUCT_URL).pathname}">Graph Eau</a>
      <button data-product-id="7"></button></div>`;
    else if (path === '/front_api/cart/new_cart') {
      type = 'application/json';
      body = JSON.stringify({items: rows.filter(row => row.sku !== 'TEST-50').map(row => ({count: row.quantity, product: {
        sku: row.sku, href: PRODUCT_URL, brand_title: 'Test Lab', title: 'Graph Eau', subtitle: row.label,
        price: (row.cart_price / 100).toFixed(2), price_original: null, can_buy: Boolean(row.in_stock)
      }}))});
    } else if (path === new URL(PRODUCT_URL).pathname) {
      if (SCENARIOS[scenario].error) {code = 503; body = 'Simulated source outage';}
      else body = '<script type="application/ld+json">' + JSON.stringify({
        '@type': 'Product', url: PRODUCT_URL, name: 'Test Lab Graph Eau', brand: {name: 'Test Lab'},
        offers: rows.map(row => ({'@type': 'Offer', name: 'Graph Eau ' + row.label, sku: row.sku,
          price: (row.public_price / 100).toFixed(2), priceCurrency: 'RUB',
          availability: 'https://schema.org/' + (row.in_stock ? 'InStock' : 'OutOfStock')}))
      }) + '</script>' + rows.map(row => `<li data-product-sku="${row.sku}" data-variant="${row.label}"></li>`).join('');
    } else {code = 404; body = 'Unknown fixture endpoint';}
    response.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'}); response.end(body);
  });
}

// Only transport is replaced: cart, favorites, authorization and product parsing use the application client.
class FixtureClient extends Randewoo {
  constructor(origin) {super('unused-test-session'); this.origin = origin; this.abort = new AbortController();}
  async get(path, {json = false} = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || this.closed) throw new FetchError('Тестовый источник недоступен');
    try {
      const response = await fetch(url, {signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)])});
      if (!response.ok) throw new FetchError('Тестовый источник вернул HTTP ' + response.status);
      return json ? await response.json() : await response.text();
    } catch (error) {throw error instanceof FetchError ? error : new FetchError('Ошибка соединения с тестовым источником');}
  }
  close() {super.close(); this.abort.abort();}
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

export async function startLab({root, port = 8001}) {
  const release = await acquireInstance(join(root, 'instance.lock'));
  let source, shop, tracker, server, closePromise, resolveStopped;
  const stopped = new Promise(resolve => {resolveStopped = resolve;});
  const close = () => closePromise ||= (async () => {
    await closeServer(server); await tracker?.close(); await closeServer(shop); source?.close();
    await release(); resolveStopped();
  })();
  try {
    source = openSource(root); shop = fixtureServer(source);
    const sourcePort = await listen(shop, 0), sourceUrl = 'http://127.0.0.1:' + sourcePort;
    tracker = new Tracker(root, {databasePath: join(root, 'history.sqlite3'), client: new FixtureClient(sourceUrl)});
    tracker.db.setSetting('schedule_enabled', false);
    const status = tracker.status.bind(tracker);
    tracker.status = () => ({...status(),test_mode:true});
    server = makeServer(tracker, {testMode: true, onShutdown: () => {close().catch(() => {});}});
    const appPort = await listen(server, port);
    return {root, source, tracker, sourceUrl, url: 'http://127.0.0.1:' + appPort, close, stopped};
  } catch (error) {await close(); throw error;}
}
