import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {get as httpGet} from 'node:http';
import {Tracker} from '../src/service.js';
import {makeServer, listen} from '../src/web.js';
import {cleanup, item, temporary} from './helpers.js';
import {Authentication, createCredentials} from '../src/auth.js';

const loginCredentials = await createCredentials('test-admin', 'test-access-password');

async function setup(t, options) {
  const root = temporary(t), tracker = new Tracker(root, {client: undefined});
  const id = tracker.db.variant(item()); tracker.db.syncList('cart', [[id, 1]]); tracker.db.observation(id, item(), 'public');
  const server = makeServer(tracker, {auth: null, ...options}), port = await listen(server, 0), base = 'http://127.0.0.1:' + port;
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

async function signIn(base, login = 'test-admin', password = 'test-access-password', cookie = '') {
  const state = await (await fetch(base + '/api/auth', {headers: {Cookie: cookie}})).json();
  return fetch(base + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token, Cookie: cookie},
    body: JSON.stringify({login, password})});
}

test('login protects all data and mutations; logout revokes the session and leaves collection running', async t => {
  const {base, tracker, id} = await setup(t, {auth: new Authentication(loginCredentials)});
  assert.equal((await fetch(base)).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), {ok: true, runtime: 'node.js', timezone: 'Europe/Moscow'});
  const state = await (await fetch(base + '/api/auth')).json();
  assert.equal(state.authenticated, false);
  for (const path of ['/api/status', '/api/dashboard', '/api/product/' + id, '/api/export']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes('Fragrance'));
  }
  for (const path of ['/api/watch', '/api/refresh', '/api/session', '/api/settings', '/api/my-cart', '/api/shutdown',
    '/api/randewoo/prepare', '/api/randewoo/send-code', '/api/randewoo/confirm', '/api/randewoo/cancel']) {
    assert.equal((await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token}, body: '{}'})).status, 401);
  }
  const response = await signIn(base), signedIn = await response.json(), setCookie = response.headers.get('set-cookie');
  assert.equal(response.status, 200);
  assert.equal(signedIn.login, 'test-admin');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Max-Age=604800/);
  assert.notEqual(signedIn.csrf_token, state.csrf_token);
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(base + '/api/dashboard', {headers: {Cookie: cookie}})).status, 200);
  const protectedPost = (path, csrfToken = signedIn.csrf_token) => fetch(base + path, {method: 'POST',
    headers: {'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken}, body: '{}'});
  assert.equal((await protectedPost('/api/logout', state.csrf_token)).status, 403);
  tracker.running = true;
  const loggedOut = await protectedPost('/api/logout');
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/dashboard', {headers: {Cookie: cookie}})).status, 401);
  assert.equal(tracker.running, true);
  assert.equal(tracker.db.rows('cart').length, 1);
});

test('login rejects wrong credentials, forged cookies, foreign origins and limits guesses', async t => {
  const {base} = await setup(t, {auth: new Authentication(loginCredentials)});
  const state = await (await fetch(base + '/api/auth')).json();
  assert.equal((await fetch(base + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token,
    Origin: 'https://evil.example'}, body: JSON.stringify({login: 'test-admin', password: 'test-access-password'})})).status, 403);
  assert.equal((await fetch(base + '/api/dashboard', {headers: {Cookie: 'pricechecker_session=forged'}})).status, 401);
  for (let index = 0; index < 8; index++) {
    const response = await signIn(base, index % 2 ? 'another-user' : 'test-admin', 'wrong-password');
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {error: 'Неверный логин или пароль'});
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const limited = await signIn(base);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
});

test('expired sessions fail closed and logins rotate an existing session', async t => {
  let now = Date.now();
  const {base} = await setup(t, {auth: new Authentication(loginCredentials, {now: () => now})});
  const first = await signIn(base), firstCookie = first.headers.get('set-cookie').split(';')[0];
  const second = await signIn(base, 'test-admin', 'test-access-password', firstCookie), secondCookie = second.headers.get('set-cookie').split(';')[0];
  assert.notEqual(firstCookie, secondCookie);
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: firstCookie}})).status, 401);
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: secondCookie}})).status, 200);
  now += 7 * 86400000 + 1;
  assert.equal((await fetch(base + '/api/status', {headers: {Cookie: secondCookie}})).status, 401);
  assert.equal((await (await fetch(base + '/api/auth', {headers: {Cookie: secondCookie}})).json()).authenticated, false);
});

test('a configured HTTPS origin is accepted and uses Secure cookies', async t => {
  const {base} = await setup(t, {auth: new Authentication(loginCredentials), publicOrigin: 'https://prices.example.com'});
  const headers = {Host: 'prices.example.com', Origin: 'https://prices.example.com'};
  const state = await (await fetch(base + '/api/auth', {headers})).json();
  const response = await fetch(base + '/api/login', {method: 'POST', headers: {...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token},
    body: JSON.stringify({login: 'test-admin', password: 'test-access-password'})});
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/);
  const hostStatus = host => new Promise((resolve, reject) => {
    httpGet(base + '/api/auth', {headers: {Host: host}}, response => {response.resume(); resolve(response.statusCode);}).on('error', reject);
  });
  assert.equal(await hostStatus('prices.example.com'), 200);
  assert.equal(await hostStatus('evil.example'), 403);
});

test('local control token can stop a signed-out app but cannot read data', async t => {
  let stopped = false;
  const {base} = await setup(t, {auth: new Authentication(loginCredentials), controlToken: 'test-local-control', onShutdown: () => {stopped = true;}});
  const headers = {Authorization: 'Bearer test-local-control'};
  assert.equal((await fetch(base + '/api/status', {headers})).status, 401);
  assert.equal((await fetch(base + '/api/shutdown', {method: 'POST', headers: {Authorization: 'Bearer invalid'}})).status, 401);
  assert.equal(stopped, false);
  assert.equal((await fetch(base + '/api/shutdown', {method: 'POST', headers})).status, 200);
  assert.equal(stopped, true);
});

test('Randewoo phone endpoints enforce CSRF, save verified cookies and expose no session secrets', async t => {
  const {base, post, tracker} = await setup(t);
  const replies = [
    {payload: '<meta name="csrf-token" content="private-csrf"><script>gon.cap_enabled=false;</script>', status: 200, headers: {'set-cookie': ['_session=guest; Path=/']}},
    {payload: '{"estimate":60}', status: 200, headers: {}},
    {payload: '{"userData":{"private":"account"}}', status: 200, headers: {'set-cookie': ['_session=private-verified-cookie; Path=/']}},
    {payload: 'gon.user={"is_authorized":true};', status: 200, headers: {}},
  ];
  tracker.randewooLogin.transport = {request: async () => replies.shift()};
  const noCsrf = await fetch(base + '/api/randewoo/prepare', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(noCsrf.status, 403); assert.equal(replies.length, 4);
  assert.equal((await post('/api/randewoo/prepare', {}, {Origin: 'https://evil.example'})).status, 403);
  const prepared = await (await post('/api/randewoo/prepare', {})).json();
  assert.equal(prepared.captcha, null);
  const data = {challenge_id: prepared.challenge_id, phone: '+79991234567'};
  assert.equal((await post('/api/randewoo/send-code', data)).status, 200);
  const confirmed = await post('/api/randewoo/confirm', {...data, code: '1234'});
  assert.equal(confirmed.status, 200); assert.deepEqual(await confirmed.json(), {connected: true});
  assert.equal(JSON.parse(readFileSync(tracker.client.sessionPath, 'utf8')).cookie, '_session=private-verified-cookie');
  const status = await (await fetch(base + '/api/status')).text();
  assert.doesNotMatch(status, /private-verified-cookie|private-csrf|userData|79991234567/);
  assert.equal(JSON.parse(status).auth_status, 'ok');
});
