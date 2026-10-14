import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Database} from '../src/database.js';
import {cleanup, item, temporary} from './helpers.js';

function setup(t) {
  const root = temporary(t), db = new Database(join(root, 'prices.sqlite3'));
  cleanup(t, () => db.close());
  const id = db.variant(item());
  const joinList = (list = 'cart', ids = [id], stamp = '2026-10-01T00:00:00+00:00') => db.syncList(list, ids.map(id => [id, 1]), stamp);
  return {root, db, id, joinList};
}

test('lists share product variants and observations', t => {
  const {db, id, joinList} = setup(t);
  joinList(); joinList('favorites'); db.observation(id, item(), 'public');
  assert.equal(db.rows('cart')[0].price, db.rows('favorites')[0].price);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM observations').n, 1);
});
test('removing and rejoining a list retains history and avoids duplicate active memberships', t => {
  const {db, id, joinList} = setup(t);
  joinList(); db.observation(id, item(), 'public');
  db.syncList('cart', []); assert.deepEqual(db.rows('cart'), []);
  db.syncList('cart', [[id, 1]]); db.syncList('cart', [[id, 2]]);
  assert.equal(db.rows('cart').length, 1); assert.equal(db.rows('cart')[0].quantity, 2);
  assert.equal(db.detail(id, 'public', 0).points.length, 1);
});
test('errors keep the last known price without creating a false zero or change', t => {
  const {db, id, joinList} = setup(t); joinList();
  db.observation(id, item(), 'public', null, '2026-10-02T10:00:00+00:00');
  db.observation(id, {status: 'error', message: 'Network error'}, 'public', null, '2026-10-02T11:00:00+00:00');
  const row = db.rows('cart')[0];
  assert.equal(row.price, 15000); assert.equal(row.minimum, 15000); assert.equal(row.status, 'error'); assert.equal(row.delta, null);
  assert.equal(db.detail(id, 'public', 0).points[1].price, null);
});
test('prices from the account cart and public site remain separate', t => {
  const {db, id, joinList} = setup(t); joinList();
  db.observation(id, item(), 'public'); db.observation(id, item({price_kopecks: 10000}), 'cart');
  assert.equal(db.rows('cart', 'public')[0].price, 15000); assert.equal(db.rows('cart', 'cart')[0].price, 10000);
  assert.equal(db.rows('cart')[0].delta, null);
});
test('different concentrations have separate histories while metadata reuses an existing variant', t => {
  const {db, id, joinList} = setup(t);
  const second = db.variant(item({sku: '456', variant: 'духи 1,5мл'}));
  assert.notEqual(second, id); assert.equal(db.variant(item({sku: null})), id);
  joinList('cart', [id, second]); assert.equal(db.rows('cart').length, 2);
});
test('missing and unavailable variants never create a complete false total', t => {
  const {db, id, joinList} = setup(t); joinList();
  const check = db.startCheck('manual');
  db.observation(id, item({in_stock: false}), 'public', check, '2026-10-02T10:00:00+00:00');
  assert.equal(db.listHistory('cart', 'public', 0)[0].price, null);
  db.observation(id, {status: 'missing', in_stock: false}, 'public', null, '2026-10-03T10:00:00+00:00');
  assert.equal(db.rows('cart')[0].price, null);
});
test('replacing a product breaks the overview line even if the count stays equal', t => {
  const {db, id, joinList} = setup(t); joinList();
  db.observation(id, item(), 'public', db.startCheck('manual'), '2026-10-02T10:00:00+00:00');
  const other = db.variant(item({url: 'https://randewoo.ru/product/another', sku: '456'}));
  db.syncList('cart', [[other, 1]], '2026-10-03T00:00:00+00:00');
  db.observation(other, item(), 'public', db.startCheck('manual'), '2026-10-03T10:00:00+00:00');
  const history = db.listHistory('cart', 'public', 0);
  assert.deepEqual(history.map(point => point.count), [1, 1]); assert.notEqual(history[0].composition, history[1].composition);
});
test('manual checks at different times are not combined into one artificial observation', t => {
  const {db, id, joinList} = setup(t); joinList();
  db.observation(id, item(), 'public', null, '2026-10-02T10:00:00+00:00');
  db.observation(id, item({price_kopecks: 20000}), 'public', null, '2026-10-03T10:00:00+00:00');
  assert.deepEqual(db.listHistory('cart', 'public', 0).map(point => point.price), [15000, 20000]);
});

test('checks in the same second retain both measurements and the latest price', t => {
  const {db, id, joinList} = setup(t); joinList();
  const stamp = '2026-10-02T10:00:00+00:00';
  db.observation(id, item(), 'public', db.startCheck('manual', stamp), stamp);
  db.observation(id, item({price_kopecks: 10000}), 'public', db.startCheck('manual', stamp), stamp);
  const row = db.rows('cart')[0];
  assert.equal(row.price, 10000); assert.equal(row.delta, -5000);
  assert.equal(db.detail(id, 'public', 0).points.length, 2);
  assert.deepEqual(db.listHistory('cart', 'public', 0).map(point => point.price), [15000, 10000]);
});

test('manual readings in the same second never double a variant in the total', t => {
  const {db, id, joinList} = setup(t); joinList();
  const stamp = '2026-10-02T10:00:00+00:00';
  db.observation(id, item(), 'public', null, stamp);
  db.observation(id, item({price_kopecks: 10000}), 'public', null, stamp);
  assert.equal(db.detail(id, 'public', 0).points.length, 2);
  const point = db.listHistory('cart', 'public', 0)[0];
  assert.equal(point.price, 10000); assert.equal(point.priced_count, 1);
});

test('removing a member during a check excludes its price from that snapshot', t => {
  const {db, id, joinList} = setup(t);
  const second = db.variant(item({url: 'https://randewoo.ru/product/another', sku: '456'}));
  joinList('watching', [id, second]);
  const check = db.startCheck('manual');
  db.observation(id, item(), 'public', check, '2026-10-02T10:00:00+00:00');
  db.syncList('watching', [[second, 1]], '2026-10-02T10:01:00+00:00');
  db.observation(second, item({price_kopecks: 20000}), 'public', check, '2026-10-02T10:02:00+00:00');
  const point = db.listHistory('watching', 'public', 0)[0];
  assert.equal(point.price, 20000); assert.equal(point.known_total, 20000);
  assert.equal(point.count, 1); assert.equal(point.priced_count, 1); assert.equal(point.complete, true);
});

test('rejoining during a check cannot reuse a price from the previous membership', t => {
  const {db, id, joinList} = setup(t);
  const second = db.variant(item({url: 'https://randewoo.ru/product/another', sku: '456'}));
  joinList('watching', [id, second]);
  const check = db.startCheck('manual');
  db.observation(id, item(), 'public', check, '2026-10-02T10:00:00+00:00');
  db.syncList('watching', [[second, 1]], '2026-10-02T10:01:00+00:00');
  db.syncList('watching', [[id, 1], [second, 1]], '2026-10-02T10:02:00+00:00');
  db.observation(second, item({price_kopecks: 20000}), 'public', check, '2026-10-02T10:03:00+00:00');
  const point = db.listHistory('watching', 'public', 0)[0];
  assert.equal(point.price, null); assert.equal(point.known_total, 20000); assert.equal(point.priced_count, 1);
});

test('a failed check does not repeat the previous price drop', t => {
  const {db, id, joinList} = setup(t); joinList();
  db.observation(id, item(), 'public', null, '2026-10-02T10:00:00+00:00');
  db.observation(id, item({price_kopecks: 10000}), 'public', null, '2026-10-02T11:00:00+00:00');
  db.observation(id, {status: 'error'}, 'public', null, '2026-10-02T12:00:00+00:00');
  const row = db.rows('cart')[0];
  assert.equal(row.price, 10000); assert.equal(row.previous_price, 15000); assert.equal(row.delta, null);
});
test('backup is readable, complete, and can replace the daily backup', async t => {
  const {db, id, root} = setup(t); db.observation(id, item(), 'public');
  const path = await db.backup(join(root, 'backups'));
  await db.backup(join(root, 'backups'));
  const copy = new DatabaseSync(path, {readOnly: true});
  try {assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);}
  finally {copy.close();}
});
test('the original Python schema and IDs migrate without losing prices', t => {
  const root = temporary(t), path = join(root, 'legacy.sqlite3');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,brand TEXT NOT NULL DEFAULT '',name TEXT NOT NULL DEFAULT '',image TEXT NOT NULL DEFAULT '');
    CREATE TABLE variants(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),volume_ml TEXT NOT NULL DEFAULT '1.5',sku TEXT,label TEXT NOT NULL DEFAULT '1,5 мл',UNIQUE(product_id,volume_ml));
    CREATE TABLE checks(id INTEGER PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,trigger TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'running',message TEXT NOT NULL DEFAULT '',completed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE observations(id INTEGER PRIMARY KEY,variant_id INTEGER NOT NULL REFERENCES variants(id),check_id INTEGER REFERENCES checks(id),checked_at TEXT NOT NULL,context TEXT NOT NULL,price INTEGER,original_price INTEGER,in_stock INTEGER,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',UNIQUE(variant_id,checked_at,context));
    INSERT INTO products VALUES(12,'https://randewoo.ru/product/legacy','Brand','Legacy','');
    INSERT INTO variants VALUES(34,12,'1.5','old-sku','духи 1,5мл');
    INSERT INTO checks(id,started_at,finished_at,trigger,status) VALUES(10,'2026-10-02T10:00:00+00:00','2026-10-02T10:00:00+00:00','import','success');
    INSERT INTO observations(id,variant_id,check_id,checked_at,context,price,in_stock,status) VALUES(56,34,10,'2026-10-02T10:00:00+00:00','public',12345,1,'ok');`);
  legacy.close();
  const db = new Database(path); cleanup(t, () => db.close());
  assert.equal(db.productVariants('https://randewoo.ru/product/legacy')[0].id, 34);
  db.syncList('cart', [[34, 1]], '2026-10-01T00:00:00+00:00');
  db.observation(34, item(), 'public', null, '2026-10-02T10:00:00+00:00');
  const second = db.variant(item({url: 'https://randewoo.ru/product/legacy', sku: 'new-sku'}));
  assert.notEqual(second, 34); assert.equal(db.rows('cart')[0].price, 15000);
  assert.equal(db.get('SELECT price FROM observations WHERE id=56').price, 12345);
  assert.equal(db.detail(34, 'public', 0).points.length, 2);
  assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});
test('unknown lists and prototype property names are rejected', t => {
  const {db} = setup(t);
  for (const key of ['__proto__', 'toString', 'missing']) assert.throws(() => db.rows(key));
});
