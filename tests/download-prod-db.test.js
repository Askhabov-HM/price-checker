import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {backup} from 'node:sqlite';
import {Database} from '../src/database.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {downloadProdDatabase} from '../scripts/download-prod-db.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'price-checker-download-'));
  const source = join(root, 'source');
  const randewoo = new Database(join(source, '.data/prices.sqlite3'));
  const ozon = new OzonDatabase(source);
  const lamoda = new LamodaDatabase(source);
  t.after(() => {
    randewoo.close(); ozon.close(); lamoda.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('price-checker-download-'));
    rmSync(root, {recursive: true, force: true});
  });
  const variant = randewoo.variant({url: 'https://randewoo.ru/product/example', sku: 'example', name: 'Example'});
  randewoo.observation(variant, {price_kopecks: 10000, in_stock: true}, 'public', null, '2026-10-26T10:00:00+00:00');
  ozon.db.exec(`INSERT INTO products(sku,url,title,created_at) VALUES('1','https://ozon.ru/product/1','Example','2026-10-26T10:00:00Z');
    INSERT INTO checks(id,trigger,status,started_at) VALUES(1,'manual','success','2026-10-26T10:00:00Z');
    INSERT INTO observations(check_id,sku,checked_at,status) VALUES(1,'1','2026-10-26T10:00:00Z','ok');`);
  lamoda.db.exec(`INSERT INTO products(sku,title,color,url,position) VALUES('1','Example','black','https://lamoda.ru/p/1',1);
    INSERT INTO checks(id,event_id,trigger,status,started_at) VALUES(1,'example','manual','success','2026-10-26T10:00:00Z');
    INSERT INTO observations(check_id,sku,checked_at,availability,status) VALUES(1,'1','2026-10-26T10:00:00Z','available','ok');`);
  const connections = {randewoo: randewoo.connection, ozon: ozon.db, lamoda: lamoda.db};
  return {root, local: join(root, 'local'), fetchSnapshot: (destination, {store}) => backup(connections[store], destination)};
}

test('downloads each store independently without replacing local databases', async t => {
  const {local, fetchSnapshot} = fixture(t);
  const first = await downloadProdDatabase('randewoo', {projectRoot: local, fetchSnapshot});
  const marker = join(local, '.data/prices.sqlite3');
  writeFileSync(marker, 'keep local data');
  const other = await downloadProdDatabase('ozon', {projectRoot: local, fetchSnapshot});
  const third = await downloadProdDatabase('lamoda', {projectRoot: local, fetchSnapshot});
  for (const result of [first, other, third]) {
    assert.equal(result.observations, 1);
    assert.ok(result.bytes > 0);
    assert.ok(existsSync(result.snapshot));
    assert.ok(result.snapshot.includes(join('prod-snapshots', result.store)));
    assert.equal(JSON.parse(readFileSync(result.snapshot + '.json', 'utf8')).store, result.store);
    assert.equal(readdirSync(join(local, '.data/prod-snapshots', result.store)).length, 2);
  }
  assert.equal(readFileSync(marker, 'utf8'), 'keep local data');
});

test('rejects a snapshot from the wrong store and removes the partial file', async t => {
  const {local, fetchSnapshot} = fixture(t);
  await assert.rejects(downloadProdDatabase('ozon', {
    projectRoot: local, fetchSnapshot: destination => fetchSnapshot(destination, {store: 'randewoo'}),
  }), /missing ozon tables/);
  assert.deepEqual(readdirSync(join(local, '.data/prod-snapshots/ozon')), []);
});

test('rejects an interrupted download without affecting earlier snapshots', async t => {
  const {local, fetchSnapshot} = fixture(t);
  const previous = await downloadProdDatabase('lamoda', {projectRoot: local, fetchSnapshot});
  await assert.rejects(downloadProdDatabase('lamoda', {projectRoot: local, fetchSnapshot: destination => {
    writeFileSync(destination, 'partial');
    throw new Error('SSH connection lost');
  }}), /SSH connection lost/);
  assert.ok(existsSync(previous.snapshot));
  assert.equal(readdirSync(join(local, '.data/prod-snapshots/lamoda')).length, 2);
});

test('rejects unknown stores before starting a download', async t => {
  const {local} = fixture(t);
  await assert.rejects(downloadProdDatabase('../other', {projectRoot: local}), /Choose randewoo, ozon, or lamoda/);
  assert.equal(existsSync(join(local, '.data')), false);
});
