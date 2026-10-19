import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {backup} from 'node:sqlite';
import {Database} from '../../../../src/database.js';
import {acquireInstance} from '../../../../src/instance.js';
import {describeDatabase, syncDatabase} from './sync-prod-db.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'price-checker-skill-sync-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('price-checker-skill-sync-'));
    rmSync(root, {recursive: true, force: true});
  });
  return root;
}

function seed(path, count, {keepOpen = false} = {}) {
  const database = new Database(path);
  const id = database.variant({url: 'https://randewoo.ru/product/skill-fixture', sku: 'fixture', name: 'Fixture'});
  for (let index = 0; index < count; index++) database.observation(id,
    {price_kopecks: 10000 + index, in_stock: true}, 'public', null, `2026-10-17T10:00:0${index}+00:00`);
  if (keepOpen) return database;
  database.close();
}

test('updates the local database and preserves its previous contents and the production snapshot', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3'), source = join(root, 'production.sqlite3');
  seed(local, 1); seed(source, 3);
  const result = await syncDatabase({root, fetchSnapshot: destination => copyFileSync(source, destination)});
  assert.equal(result.mode, 'synced');
  assert.equal(describeDatabase(local).observations, 3);
  assert.equal(describeDatabase(result.local_backup).observations, 1);
  assert.equal(describeDatabase(result.snapshot).observations, 3);
  assert.equal(describeDatabase(source).observations, 3);
  assert.ok(existsSync(result.snapshot + '.json'));
});

test('copies committed data from the WAL into the backup before updating the local database', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3'), source = join(root, 'production.sqlite3');
  const database = seed(local, 2, {keepOpen: true});
  seed(source, 4);
  try {
    assert.ok(existsSync(local + '-wal'));
    const result = await syncDatabase({root, fetchSnapshot: destination => copyFileSync(source, destination)});
    assert.equal(describeDatabase(result.local_backup).observations, 2);
    assert.equal(describeDatabase(local).observations, 4);
  } finally {database.close();}
});

test('rejects an invalid downloaded file before changing the local database', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3');
  seed(local, 2);
  await assert.rejects(syncDatabase({root, fetchSnapshot: destination => writeFileSync(destination, 'broken database')}));
  assert.equal(describeDatabase(local).observations, 2);
  assert.deepEqual(readdirSync(join(root, '.data/prod-snapshots')), []);
  assert.equal(existsSync(join(root, '.data/local-backups')), false);
});

test('refuses to download or change data while the local application holds its lock', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3');
  seed(local, 1);
  const release = await acquireInstance(join(root, '.data/app.lock'));
  let fetched = false;
  try {
    await assert.rejects(syncDatabase({root, fetchSnapshot: () => {fetched = true;}}), /Local Price Checker is running/);
    assert.equal(fetched, false);
    assert.equal(describeDatabase(local).observations, 1);
  } finally {await release();}
});

test('snapshot-only works while the local application is running and leaves its database intact', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3'), source = join(root, 'production.sqlite3');
  seed(local, 1);
  const database = seed(source, 3, {keepOpen: true});
  const release = await acquireInstance(join(root, '.data/app.lock'));
  try {
    const result = await syncDatabase({root, snapshotOnly: true, fetchSnapshot: destination => backup(database.connection, destination)});
    assert.equal(result.mode, 'snapshot-only');
    assert.equal(result.local_backup, null);
    assert.equal(result.local_database, null);
    assert.equal(describeDatabase(local).observations, 1);
    assert.equal(describeDatabase(result.snapshot).observations, 3);
  } finally {database.close(); await release();}
});

test('an interrupted download is removed and releases the local application lock', async t => {
  const root = workspace(t), local = join(root, '.data/prices.sqlite3');
  seed(local, 1);
  await assert.rejects(syncDatabase({root, fetchSnapshot: destination => {
    writeFileSync(destination, 'partial download');
    throw new Error('SSH connection lost');
  }}), /SSH connection lost/);
  assert.equal(describeDatabase(local).observations, 1);
  assert.deepEqual(readdirSync(join(root, '.data/prod-snapshots')), []);
  const release = await acquireInstance(join(root, '.data/app.lock'));
  await release();
});
