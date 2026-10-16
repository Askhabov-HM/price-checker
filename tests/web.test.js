import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Tracker} from '../src/service.js';
import {makeServer, listen} from '../src/web.js';
import {cleanup, item, temporary} from './helpers.js';

async function setup(t, options) {
  const root = temporary(t), tracker = new Tracker(root, {client: undefined});
  const id = tracker.db.variant(item()); tracker.db.syncList('cart', [[id, 1]]); tracker.db.observation(id, item(), 'public');
  const server = makeServer(tracker, options), port = await listen(server, 0), base = 'http://127.0.0.1:' + port;
  cleanup(t, async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await tracker.close();});
  const status = await (await fetch(base + '/api/status')).json();
  const post = (path, data, headers = {}) => fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token, ...headers}, body: JSON.stringify(data)});
  return {root, tracker, id, base, post, status};
}
test('local UI, dashboard, history, assets, and Excel CSV are served', async t => {
  const {base, id} = await setup(t);
  const page = await fetch(base); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /Price Checker/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith('.js'))); assert.ok(assets.some(path => path.endsWith('.css')));
  for (const path of assets) assert.equal((await fetch(base + path)).status, 200);
  for (const path of ['/cart', '/my-cart', '/favorites', '/watching']) assert.equal(await (await fetch(base + path)).text(), html);
  for (const path of ['/assets/missing.js', '/src/web.js', '/package.json', '/api/unknown', '/.secrets/randewoo-session.json']) assert.equal((await fetch(base + path)).status, 404);
  const dashboard = await (await fetch(base + '/api/dashboard?list=cart')).json();
  assert.equal(dashboard.items[0].price, 15000); assert.equal(dashboard.counts.cart, 1);
  assert.equal((await (await fetch(base + '/api/product/' + id + '?days=0')).json()).points.length, 1);
  const response = await fetch(base + '/api/export?list=cart'), csv = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...csv.subarray(0, 3)], [239, 187, 191]); assert.match(csv.toString('utf8'), /150,00/);
  assert.equal(csv.toString('utf8').trim().split('\n').length, 2);
});

test('CSV distinguishes a failed attempt from the date of the last known price', async t => {
  const {base, tracker, id} = await setup(t);
  const priceAt = tracker.db.rows('cart')[0].price_at;
  tracker.db.observation(id, {status: 'error', message: 'Network; unavailable'}, 'public');
  const csv = await (await fetch(base + '/api/export?list=cart')).text();
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /Статус проверки;Цена получена UTC;Сообщение/);
  assert.match(lines[1], /;150,00;;Неизвестно;/);
  assert.ok(lines[1].includes(`;Ошибка проверки;${priceAt};"Network; unavailable"`));
  const dashboard = await (await fetch(base + '/api/dashboard?list=cart')).json();
  assert.equal(dashboard.items[0].status, 'error');
  assert.equal(dashboard.items[0].price, 15000);
  assert.equal(dashboard.items[0].delta, null);
});
test('dashboard exposes the last price event after unchanged and failed refreshes', async t => {
  const {base, tracker, id} = await setup(t);
  const stamp = tracker.db.rows('cart')[0].checked_at;
  tracker.db.observation(id, item({price_kopecks: 10000}), 'public', null, stamp);
  tracker.db.observation(id, item({price_kopecks: 10000}), 'public', null, stamp);
  let dashboard = await (await fetch(base + '/api/dashboard?list=cart')).json();
  assert.equal(dashboard.items[0].delta, 0);
  const event = {checked_at: stamp, previous_price: 15000, price: 10000, delta: -5000};
  assert.deepEqual(dashboard.items[0].last_change, event);
  tracker.db.observation(id, {status: 'error'}, 'public', null, stamp);
  dashboard = await (await fetch(base + '/api/dashboard?list=cart')).json();
  assert.equal(dashboard.items[0].status, 'error');
  assert.deepEqual(dashboard.items[0].last_change, event);
});
test('CSRF and origin validation protect changes; valid watch requests persist', async t => {
  const {base, post, id, tracker} = await setup(t);
  assert.equal((await fetch(base + '/api/watch', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, active: true})})).status, 403);
  assert.equal((await post('/api/watch', {id, active: true}, {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await post('/api/watch', {id, active: true})).status, 200); assert.equal(tracker.db.rows('watching').length, 1);
  assert.equal((await post('/api/watch', {id, active: false})).status, 200); assert.equal(tracker.db.rows('watching').length, 0);
  assert.equal(tracker.db.detail(id).points.length, 1);
});

test('personal cart API validates requests, preserves the account cart, and exports its own selection', async t => {
  const {base, post, id, tracker} = await setup(t);
  const before = tracker.db.rows('cart');
  assert.equal((await fetch(base + '/api/my-cart', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, active: true})})).status, 403);
  assert.equal((await post('/api/my-cart', {id, active: true}, {Origin: 'https://evil.example'})).status, 403);
  for (const data of [{id: '1', active: true}, {id, active: 'true'}, {id: 9999, active: true}]) assert.equal((await post('/api/my-cart', data)).status, 400);
  assert.equal((await post('/api/my-cart', {id, active: true})).status, 200);
  assert.equal((await post('/api/my-cart', {id, active: true})).status, 200);
  const dashboard = await (await fetch(base + '/api/dashboard?list=my-cart')).json();
  assert.equal(dashboard.items.length, 1);
  assert.equal(dashboard.items[0].in_my_cart, true);
  assert.equal(dashboard.items[0].price, 15000);
  assert.equal(dashboard.counts['my-cart'], 1);
  assert.deepEqual(tracker.db.rows('cart'), before.map(row => ({...row, in_my_cart: true})));
  const csv = await (await fetch(base + '/api/export?list=my-cart')).text();
  assert.match(csv, /150,00/);
  assert.equal((await post('/api/my-cart', {id, active: false})).status, 200);
  assert.deepEqual(tracker.db.rows('cart'), before);
  assert.equal(tracker.db.rows('my-cart').length, 0);
  tracker.client.products = async () => [item()];
  assert.equal((await post('/api/my-cart/add', {url: item().url})).status, 200);
  assert.equal(tracker.db.rows('my-cart').length, 1);
  assert.equal(tracker.db.rows('watching').length, 0);
});
test('session values are saved locally and never returned by API', async t => {
  const {base, post, tracker} = await setup(t);
  assert.equal((await post('/api/session', {cookie: 'test-session-value', user_agent: 'test-agent'})).status, 200);
  assert.equal(JSON.parse(readFileSync(tracker.client.sessionPath, 'utf8')).cookie, 'test-session-value');
  for (const path of ['/api/status', '/api/dashboard']) {
    const text = await (await fetch(base + path)).text(); assert.ok(!text.includes('test-session-value')); assert.ok(!text.includes('test-agent'));
  }
});
test('private files, databases, dependencies, and arbitrary paths are inaccessible', async t => {
  const {base} = await setup(t);
  for (const path of ['/.secrets/randewoo-session.json', '/.data/prices.sqlite3', '/src/client.js', '/package.json', '/node_modules/cheerio/package.json', '/README.md']) assert.equal((await fetch(base + path)).status, 404);
});
test('bad API inputs return controlled errors and do not expose user input', async t => {
  const {base, post, status} = await setup(t);
  assert.equal((await fetch(base + '/api/dashboard?list=__proto__')).status, 400);
  assert.equal((await fetch(base + '/api/product/1?days=invalid')).status, 400);
  assert.equal((await post('/api/watch', {id: '1', active: true})).status, 400);
  assert.equal((await post('/api/session', {cookie: 'unsafe\nsecret', user_agent: 'test'})).status, 400);
  const malformed = await fetch(base + '/api/settings', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token}, body: 'private-invalid-json'});
  assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes('private-invalid-json'));
  assert.equal((await post('/api/settings', {}, {'Content-Type': 'text/plain'})).status, 415);
});
test('refresh requests reject overlapping checks', async t => {
  const {post, tracker} = await setup(t); tracker.startRefresh = () => false;
  assert.equal((await post('/api/refresh', {})).status, 409);
});
test('shutdown requires authentication to the local page and runs after responding', async t => {
  let stopped = false;
  const {post, base} = await setup(t, {onShutdown: () => {stopped = true;}});
  assert.equal((await fetch(base + '/api/shutdown', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  assert.equal(stopped, false); assert.equal((await post('/api/shutdown', {})).status, 200); assert.equal(stopped, true);
});
