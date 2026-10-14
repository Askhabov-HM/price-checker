import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync, utimesSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {Tracker} from '../src/service.js';
import {DatabaseSync} from 'node:sqlite';
import {now, scheduleSlot, nextCheck} from '../src/time.js';
import {acquireInstance} from '../src/instance.js';
import {AuthError, FetchError} from '../src/errors.js';
import {cleanup, item, temporary} from './helpers.js';

function setup(t, client = {}) {
  const root = temporary(t), tracker = new Tracker(root, {client});
  cleanup(t, () => tracker.close());
  return {root, tracker};
}
const times = ['00:30', '09:00', '14:00', '20:00'];

test('schedule handles Moscow midnight and stores Python-compatible UTC timestamps', () => {
  const current = new Date('2026-10-09T00:10:00+03:00');
  assert.equal(scheduleSlot(times, current), '2026-10-08T20:00:00+03:00');
  assert.equal(nextCheck(times, current), '2026-10-09T00:30:00+03:00');
  assert.equal(now(new Date('2026-10-09T00:10:00+03:00')), '2026-10-08T21:10:00+00:00');
});
test('missed intervals run once and pause is respected', t => {
  const {tracker} = setup(t), current = new Date('2026-10-09T15:00:00+03:00');
  let calls = 0; tracker.startRefresh = () => {calls++; return true;};
  assert.equal(tracker.schedulerTick(current), true); assert.equal(tracker.schedulerTick(current), false); assert.equal(calls, 1);
  tracker.db.setSetting('schedule_enabled', false); assert.equal(tracker.schedulerTick(new Date('2026-10-10T15:00:00+03:00')), false);
});
test('restart allows retrying an unfinished interval', async t => {
  const root = temporary(t), tracker = new Tracker(root), current = new Date('2026-10-09T15:00:00+03:00');
  tracker.db.setSetting('last_started_slot', scheduleSlot(times, current)); await tracker.close();
  const restarted = new Tracker(root); cleanup(t, () => restarted.close());
  restarted.startRefresh = () => true; assert.equal(restarted.schedulerTick(current), true);
});
test('invalid settings never replace the good schedule', t => {
  const {tracker} = setup(t), before = tracker.db.setting('schedule');
  assert.throws(() => tracker.saveSettings({schedule: ['25:00'], schedule_enabled: true}));
  assert.deepEqual(tracker.db.setting('schedule'), before);
  tracker.saveSettings({schedule: ['20:00', '09:00', '09:00'], schedule_enabled: false});
  assert.deepEqual(tracker.db.setting('schedule'), ['09:00', '20:00']);
});
test('expired authentication preserves lists while public prices still update', async t => {
  const {tracker} = setup(t, {authorizedUser: async () => {throw new AuthError('Сессия истекла');}, products: async () => [item({price_kopecks: 12300})]});
  const id = tracker.db.variant(item()); tracker.db.syncList('cart', [[id, 1]]);
  const result = await tracker.refreshNow('test');
  assert.equal(result.errors, 1); assert.equal(tracker.db.rows('cart').length, 1); assert.equal(tracker.db.rows('cart')[0].price, 12300);
  assert.equal(tracker.db.setting('auth_status'), 'expired');
});

for (const failure of ['authentication', 'cart']) test(`${failure} failures mark account prices stale while public prices update`, async t => {
  const {tracker} = setup(t, {
    authorizedUser: async () => {if (failure === 'authentication') throw new AuthError('Session expired'); return {};},
    cart: async () => {throw new FetchError('Cart failed');}, favorites: async () => [],
    products: async () => [item({price_kopecks: 12300})]
  });
  const id = tracker.db.variant(item()), stamp = '2026-10-01T10:00:00+00:00';
  tracker.db.syncList('cart', [[id, 2]], stamp);
  tracker.db.observation(id, item({price_kopecks: 10000}), 'cart', null, stamp);
  const result = await tracker.refreshNow('test'), row = tracker.db.rows('cart', 'cart')[0];
  assert.equal(result.errors, 1); assert.equal(row.status, 'error'); assert.equal(row.price, 10000);
  assert.equal(row.price_at, stamp); assert.equal(row.delta, null); assert.equal(row.quantity, 2);
  assert.equal(tracker.db.rows('cart')[0].price, 12300);
  const history = tracker.db.listHistory('cart', 'cart', 0);
  assert.equal(history.at(-1).priced_count, 0); assert.equal(history.at(-1).price, null);
  tracker.client.authorizedUser = async () => ({});
  tracker.client.cart = async () => [item({matches_target_volume: true, quantity: 2, price_kopecks: 9000})];
  await tracker.refreshNow('test');
  assert.equal(tracker.db.rows('cart', 'cart')[0].status, 'ok');
  assert.equal(tracker.db.rows('cart', 'cart')[0].price, 9000);
});

test('a public sample inferred from another cart size cannot reuse an old account price', async t => {
  const {tracker} = setup(t, {authorizedUser: async () => ({}), favorites: async () => [],
    cart: async () => [item({sku: '999', variant: 'EDP 50 ml', matches_target_volume: false, quantity: 1})],
    products: async () => [item()]});
  const id = tracker.db.variant(item());
  tracker.db.syncList('cart', [[id, 1]], '2026-10-01T00:00:00+00:00');
  tracker.db.observation(id, item({price_kopecks: 10000}), 'cart', null, '2026-10-01T10:00:00+00:00');
  await tracker.refreshNow('test');
  assert.equal(tracker.db.rows('cart')[0].price, 15000);
  assert.equal(tracker.db.rows('cart', 'cart')[0].price, null);
  assert.equal(tracker.db.rows('cart', 'cart')[0].status, 'missing');
});
test('one parent product is requested once and exact cart SKU stays separate from favorite concentrations', async t => {
  let calls = 0;
  const {tracker} = setup(t, {authorizedUser: async () => ({}),
    cart: async () => [item({matches_target_volume: true, quantity: 2, price_kopecks: 10000})],
    favorites: async () => [item({sku: null})], products: async () => {calls++; return [item(), item({sku: '456', price_kopecks: 25000})];}});
  const result = await tracker.refreshNow('test');
  assert.equal(result.errors, 0); assert.equal(calls, 1);
  assert.deepEqual(tracker.db.counts(), {favorites: 2, cart: 1, watching: 0});
  assert.equal(tracker.db.rows('cart', 'cart')[0].price, 10000); assert.equal(tracker.db.rows('cart')[0].price, 15000);
});
test('failed favorite synchronization keeps its old members', async t => {
  const {tracker} = setup(t, {authorizedUser: async () => ({}), cart: async () => [],
    favorites: async () => {throw new FetchError('Incomplete favorites');}, products: async () => [item()]});
  const id = tracker.db.variant(item()); tracker.db.syncList('favorites', [[id, 1]]);
  const result = await tracker.refreshNow('test');
  assert.equal(result.errors, 1); assert.equal(tracker.db.rows('favorites').length, 1);
});
test('manual additions track every 1.5 ml concentration', async t => {
  const {tracker} = setup(t, {products: async () => [item(), item({sku: '456', price_kopecks: 25000})]});
  await tracker.addUrl(item().url);
  assert.equal(tracker.db.rows('watching').length, 2); assert.equal(tracker.db.get('SELECT COUNT(*) AS n FROM observations').n, 2);
});
test('shutdown cancels an active read and preserves previously saved prices', async t => {
  let entered, cancel;
  const reading = new Promise(resolve => {entered = resolve;});
  const {root, tracker} = setup(t, {authorizedUser: async () => {throw new AuthError('Expired');},
    products: () => new Promise((resolve, reject) => {cancel = reject; entered();}), close: () => cancel?.(new FetchError('Stopped'))});
  const id = tracker.db.variant(item()); tracker.db.syncList('cart', [[id, 1]]); tracker.db.observation(id, item(), 'public');
  const refresh = tracker.refreshNow('test'); await reading; await tracker.close();
  assert.equal((await refresh).errors, 1);
  const copy = new DatabaseSync(join(root, '.data/prices.sqlite3'), {readOnly: true});
  try {
    assert.equal(copy.prepare('SELECT status FROM checks ORDER BY id DESC LIMIT 1').get().status, 'interrupted');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
    assert.equal(copy.prepare('SELECT price FROM observations').get().price, 15000);
  } finally {copy.close();}
});
test('instance locking excludes another process and releases normally', async t => {
  const root = temporary(t), path = join(root, 'app.lock'), release = await acquireInstance(path);
  const module = pathToFileURL(join(process.cwd(), 'src/instance.js')).href;
  const code = `import {acquireInstance,AlreadyRunning} from ${JSON.stringify(module)}; try {const release=await acquireInstance(${JSON.stringify(path)}); await release(); process.exitCode=0;} catch(e) {process.exitCode=e instanceof AlreadyRunning?42:43;}`;
  try {await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]), error => error.code === 42);}
  finally {await release();}
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
});
test('an abandoned stale process lock is recovered', async t => {
  const root = temporary(t), path = join(root, 'app.lock');
  // lockfile creates the target and uses an atomic directory with a heartbeat.
  const release = await acquireInstance(path); await release();
  mkdirSync(path + '.lock');
  const old = new Date(Date.now() - 20000); utimesSync(path + '.lock', old, old);
  const recovered = await acquireInstance(path); await recovered();
});
