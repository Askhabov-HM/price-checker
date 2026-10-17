import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ozonProduct, probeTarget} from '../src/providers/ozon/url.js';
import {probeOzon, retryAfterMs, inspectOzonHtml, OZON_INTERVAL_MS, PROBE_LIMIT_BYTES} from '../src/providers/ozon/probe.js';
import {OzonProbeStore, ozonProbePaths} from '../src/providers/ozon/probe-store.js';
import {Database} from '../src/database.js';
import {cleanup, item, temporary} from './helpers.js';

const current = Date.parse('2026-10-17T18:00:00Z');
const product = 'https://www.ozon.ru/product/test-product-585979289/';
const result = (extra = {}) => ({checked_at: new Date(current).toISOString(), target_kind: 'product', external_id: '585979289',
  http_status: 200, outcome: 'html_received', body_bytes: 100, retry_after_ms: 0, ...extra});
function setup(t) {
  const root = temporary(t), paths = ozonProbePaths(root), store = new OzonProbeStore(paths.database);
  cleanup(t, () => store.close());
  return {root, paths, store};
}

test('Ozon URLs discard tracking and preserve the exact numeric variant ID', () => {
  assert.deepEqual(ozonProduct(product + '?from_sku=999&at=private#reviews'), {url: product, external_id: '585979289'});
  assert.equal(ozonProduct('https://ozon.ru/product/123456/').url, 'https://www.ozon.ru/product/123456/');
  assert.equal(ozonProduct('https://www.ozon.ru/product/товар-123456/').external_id, '123456');
  assert.equal(ozonProduct('https://www.ozon.ru/product/товар-123456/').url, 'https://www.ozon.ru/product/%D1%82%D0%BE%D0%B2%D0%B0%D1%80-123456/');
  assert.equal(probeTarget().kind, 'home');
  assert.notEqual(ozonProduct(product).external_id, ozonProduct(product.replace('585979289', '585979290')).external_id);
});

test('foreign domains, credentials, explicit ports, escaped separators and non-product URLs never reach the network', async () => {
  const invalid = ['http://www.ozon.ru/product/123/', 'https://ozon.ru.evil.test/product/123/',
    'https://user:pass@www.ozon.ru/product/123/', 'https://www.ozon.ru:443/product/123/',
    'https://www.ozon.ru/product/a%2f123/', 'https://www.ozon.ru/product/a%5c123/',
    'https://www.ozon.ru/product/a%00123/', 'https://www.ozon.ru/product/product/',
    'https://www.ozon.ru/my/favorites', '/product/123/', 'https://randewoo.ru/product/123',
    'https://www.ozon.ru/product/123/reviews/', 'https://www.ozon.ru/product/123/\nfoo'];
  for (const url of invalid) {
    let fetched = false;
    await assert.rejects(probeOzon(url, {fetchImpl: async () => {fetched = true;}}), /ссылка/);
    assert.equal(fetched, false, url);
  }
});

test('one public GET never follows redirects, sends credentials or prints redirect query parameters', async () => {
  const calls = [];
  const response = new Response('secret-session private-address', {status: 307, headers: {Location: product + '?token=secret-session'}});
  const probe = await probeOzon(product, {current: () => current, fetchImpl: async (...args) => {calls.push(args); return response;}});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[0][1].headers.Cookie, undefined);
  assert.equal(probe.outcome, 'redirect');
  assert.equal(probe.signals.redirect_same_path, true);
  assert.equal(probe.signals.redirect_query_changed, true);
  assert.doesNotMatch(JSON.stringify(probe), /secret-session|private-address|token=/);
  assert.equal(response.body.locked, false);
});

test('bank-offer text remains a diagnostic signal and is never returned as a verified Ozon Card price', () => {
  const signals = inspectOzonHtml('<title>Товар</title><h1>Товар</h1><button>220 ₽ С банками</button><p>242 ₽ С другими банками</p><script>captcha secret-cookie</script>');
  assert.equal(signals.bank_price_label, true);
  assert.equal(signals.other_banks_label, true);
  assert.equal(signals.ozon_card_label, false);
  assert.equal(signals.access_limited, false);
  assert.equal(Object.keys(signals).some(key => /kopecks|^price$/.test(key)), false);
});

test('HTTP 200 access restrictions and login pages are not mistaken for product data', async () => {
  for (const [html, expected] of [
    ['<title>Доступ ограничен</title><p>Обновите страницу</p>', 'access_limited'],
    ['<h1>Подтвердите, что вы не робот</h1>', 'access_limited'],
    ['<h1>CAPTCHA</h1>', 'access_limited'],
    ['<h1>Вход в аккаунт</h1>', 'login_required'],
  ]) {
    let calls = 0;
    const probe = await probeOzon(product, {fetchImpl: async () => {calls++; return new Response(html, {headers: {'Content-Type': 'text/html; charset=utf-8'}});}});
    assert.equal(probe.outcome, expected);
    assert.equal(calls, 1);
  }
});

test('429, forbidden, unauthorized and temporary errors make one attempt; failures expose no raw error', async () => {
  for (const [status, expected] of [[429, 'rate_limited'], [403, 'access_limited'], [401, 'login_required'], [503, 'http_error']]) {
    let calls = 0;
    const probe = await probeOzon(product, {current: () => current, fetchImpl: async () => {
      calls++; return new Response('secret-body', {status, headers: {'Retry-After': '10800'}});
    }});
    assert.equal(probe.outcome, expected); assert.equal(calls, 1);
    if (status === 429) assert.equal(probe.retry_after_ms, 10800000);
    assert.doesNotMatch(JSON.stringify(probe), /secret-body/);
  }
  const error = await probeOzon(product, {fetchImpl: async () => {throw new Error('cookie=private; address=secret');}});
  assert.equal(error.outcome, 'network_error');
  assert.doesNotMatch(JSON.stringify(error), /private|secret/);
});

test('unexpected content is rejected and oversized streams are cancelled instead of retained', async () => {
  const json = await probeOzon(product, {fetchImpl: async () => new Response('{"private":"secret"}', {headers: {'Content-Type': 'application/json'}})});
  assert.equal(json.outcome, 'unexpected_content');
  let cancelled = false;
  const stream = new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(PROBE_LIMIT_BYTES + 1));}, cancel() {cancelled = true;}});
  const oversized = await probeOzon(product, {fetchImpl: async () => new Response(stream, {headers: {'Content-Type': 'text/html'}})});
  assert.equal(oversized.outcome, 'response_too_large'); assert.equal(cancelled, true);
  assert.equal(oversized.signals, undefined);
});

test('Retry-After supports seconds and HTTP dates without shortening an excessive server pause', () => {
  assert.equal(retryAfterMs('3600', current), 3600000);
  assert.equal(retryAfterMs('Sat, 17 Oct 2026 21:00:00 GMT', current), 10800000);
  assert.equal(retryAfterMs('Sat, 17 Oct 2026 17:00:00 GMT', current), 0);
  assert.equal(retryAfterMs('invalid', current), 0);
  assert.ok(retryAfterMs('99999999999999999999999999999', current) > OZON_INTERVAL_MS);
});

test('Ozon diagnostics never opens or modifies the existing Randewoo database', t => {
  const root = temporary(t), randewooFile = join(root, '.data/prices.sqlite3');
  const randewoo = new Database(randewooFile);
  const id = randewoo.variant(item()); randewoo.watch(id); randewoo.observation(id, item(), 'public'); randewoo.close();
  const before = readFileSync(randewooFile);
  const paths = ozonProbePaths(root), store = new OzonProbeStore(paths.database);
  store.record(result(), current); store.close();
  assert.deepEqual(readFileSync(randewooFile), before);
  assert.notEqual(paths.database, randewooFile);
  assert.equal(existsSync(join(root, '.data/ozon/prices.sqlite3')), false);
});

test('foreign and newer databases are rejected before writes or diagnostic initialization', t => {
  const root = temporary(t), foreign = join(root, 'foreign.sqlite3');
  const db = new Database(foreign); db.variant(item()); db.close();
  const before = readFileSync(foreign);
  assert.throws(() => new OzonProbeStore(foreign), /не является/);
  assert.deepEqual(readFileSync(foreign), before);
  const futureFile = join(root, 'future.sqlite3'), future = new DatabaseSync(futureFile);
  future.exec("CREATE TABLE probe_meta(id INTEGER PRIMARY KEY,provider TEXT,schema_version INTEGER); INSERT INTO probe_meta VALUES(1,'ozon-probe',2);"); future.close();
  const snapshot = readFileSync(futureFile);
  assert.throws(() => new OzonProbeStore(futureFile), /не является/);
  assert.deepEqual(readFileSync(futureFile), snapshot);
});

test('cooldown survives restart; manual acknowledgement cannot shorten Retry-After', t => {
  const root = temporary(t), {database} = ozonProbePaths(root);
  let store = new OzonProbeStore(database);
  store.record(result({outcome: 'rate_limited', http_status: 429, retry_after_ms: 36000000}), current);
  store.close(); store = new OzonProbeStore(database); cleanup(t, () => store.close());
  assert.equal(store.status(current + OZON_INTERVAL_MS).allowed, false);
  assert.throws(() => store.acknowledge(current + OZON_INTERVAL_MS), /ещё не истёк/);
  assert.throws(() => store.record(result(), current), /приостановлена/);
  assert.equal(store.status(current + 36000000).allowed, true);
  store.record(result({outcome: 'rate_limited', http_status: 429}), current + 36000000);
  assert.equal(store.status(current + 86400000).action_required, true);
  assert.equal(store.status(current + 86400000).allowed, false);
});

test('a reserved request that loses its process remains paused after restart, even when its interval has elapsed', t => {
  const {database} = ozonProbePaths(temporary(t));
  let store = new OzonProbeStore(database);
  store.beginAttempt(current);
  assert.equal(store.status(current).reason, 'interrupted_attempt');
  store.close(); store = new OzonProbeStore(database); cleanup(t, () => store.close());
  assert.equal(store.status(current + 86400000).allowed, false);
  assert.throws(() => store.beginAttempt(current + 86400000), /приостановлена/);
});

test('a completed reserved read replaces the interrupted pause with its actual result', t => {
  const {store} = setup(t);
  store.beginAttempt(current);
  const state = store.record(result({outcome: 'json_received'}), current);
  assert.equal(state.action_required, false); assert.equal(state.reason, 'interval');
  assert.equal(state.allowed, false);
  assert.equal(store.status(current + OZON_INTERVAL_MS).allowed, true);
});

test('temporary errors back off and stop on repeated failure; a 429 without Retry-After waits longer than a normal read', t => {
  const {store} = setup(t);
  let time = current;
  for (const status of [503, null, 502]) {
    store.beginAttempt(time);
    const state = store.record(result({http_status: status, outcome: status ? 'http_error' : 'network_error'}), time);
    assert.ok(Date.parse(state.not_before) - time >= OZON_INTERVAL_MS);
    time = Date.parse(state.not_before);
  }
  assert.equal(store.status(time + 86400000).allowed, false);
  store.acknowledge(time + 86400000);
  const state = store.record(result({http_status: 429, outcome: 'rate_limited'}), time + 86400000);
  assert.ok(Date.parse(state.not_before) - (time + 86400000) > OZON_INTERVAL_MS);
});

test('redirect and access restrictions require explicit acknowledgement even after the interval', t => {
  const {store} = setup(t);
  store.record(result({outcome: 'redirect', http_status: 307}), current);
  assert.equal(store.status(current + 86400000).allowed, false);
  assert.equal(store.acknowledge(current + 86400000).allowed, true);
  store.record(result({outcome: 'access_limited', http_status: 403}), current + 86400000);
  assert.equal(store.status(current + 2 * 86400000).allowed, false);
});

test('probe storage persists only whitelisted signals, not injected credentials, addresses or response bodies', t => {
  const {store, paths} = setup(t);
  store.record(result({cookie: 'secret-cookie', html: 'private-address', signals: {bank_price_label: true,
    redirect_same_path: true, token: 'secret-token', location: 'https://www.ozon.ru/?private=secret-token'}}), current);
  const db = new DatabaseSync(paths.database, {readOnly: true}); cleanup(t, () => db.close());
  const rows = JSON.stringify(db.prepare('SELECT * FROM probes').all());
  assert.doesNotMatch(rows, /secret-cookie|private-address|secret-token|"token"/);
  assert.match(rows, /bank_price_label/);
  assert.equal(store.status(current).last_probe.signals.redirect_same_path, true);
  assert.equal(store.status(current).account_connected, false);
  assert.equal(store.status(current).collector_enabled, false);
});
