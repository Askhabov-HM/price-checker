import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Database} from '../src/database.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {RowCache,HistoryCache} from '../src/dashboard-cache.js';
import {CollectionSnapshot} from '../src/collection-snapshot.js';
import {migrate,assertStorage,tableExists} from '../src/storage-migrations.js';
import {prepareStores,checkStores,warmRuntime,runtimeReadiness} from '../src/storage-maintenance.js';
import {CollectionQueue} from '../src/collection-queue.js';
import {acquireInstance,AlreadyRunning} from '../src/instance.js';
import {item} from './helpers.js';

function root(t) {
  const directory = mkdtempSync(join(tmpdir(),'price-storage-'));
  t.after(() => rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50}));return directory;
}
function memory(t) {const db = new DatabaseSync(':memory:');t.after(() => db.close());return db;}

test('migration failure rolls back schema, data and journal; retries apply exactly once',t => {
  const sql = memory(t);sql.exec('CREATE TABLE source(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO source VALUES(1,\'original\')');
  const apply = () => {sql.exec('ALTER TABLE source ADD COLUMN extra TEXT');sql.exec("UPDATE source SET value='changed'");throw new Error('injected');};
  assert.throws(() => migrate(sql,{component:'example',apply}),/injected/);
  assert.equal(sql.prepare('SELECT value FROM source').get().value,'original');
  assert.equal(sql.prepare('PRAGMA table_info(source)').all().length,2);
  assert.equal(tableExists(sql,'storage_migrations'),false);
  const definition = {component:'example',apply:() => sql.exec("ALTER TABLE source ADD COLUMN extra TEXT; UPDATE source SET value='changed'")};
  assert.equal(migrate(sql,definition),true);assert.equal(migrate(sql,definition),false);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM storage_migrations').get().n,1);
  assert.throws(() => migrate(sql,{component:'example',apply:() => {}}),/checksum/);
  assert.throws(() => migrate(sql,{component:'example',version:3,apply:() => {}}),/order/);
});

test('known legacy stores retain observations, account bindings and schedules when adopted',t => {
  const directory = root(t);
  for (const [store,open] of [['randewoo',() => new Database(join(directory,'.data/prices.sqlite3'))],['ozon',() => new OzonDatabase(directory)],['lamoda',() => new LamodaDatabase(directory)]]) {
    let db = open(),sql = db.connection || db.db;
    if (store === 'randewoo') {
      db.setSetting('schedule',['07:00']);db.observation(db.variant(item()),item(),'public',null,'2026-01-01T00:00:00.000Z');
    } else {
      sql.exec("UPDATE collector_state SET schedule_enabled=1,interval_minutes=120");
      if (store === 'ozon') {
        db.bindContext('synthetic-account-context');
        sql.exec("INSERT INTO products(sku,url,title,created_at) VALUES('123','https://www.ozon.ru/product/123/','Synthetic','2026-01-01'); INSERT INTO checks(id,trigger,status,started_at,finished_at) VALUES(1,'test','success','2026-01-01','2026-01-01'); INSERT INTO observations(check_id,sku,checked_at,status,availability,listed_price_kopecks) VALUES(1,'123','2026-01-01','ok','available',10000)");
      } else {
        db.bindAccount('42');
        sql.exec("INSERT INTO products(sku,title,color,url,position) VALUES('ABCDEF','Synthetic','','https://www.lamoda.ru/p/abcdef/',0); INSERT INTO checks(id,event_id,trigger,status,started_at,finished_at) VALUES(1,'synthetic','test','success','2026-01-01','2026-01-01'); INSERT INTO observations(check_id,sku,checked_at,price_at,price,availability,status) VALUES(1,'ABCDEF','2026-01-01','2026-01-01',10000,'available','ok')");
      }
    }
    const before = sql.prepare('SELECT * FROM observations').all();
    const account = store === 'randewoo' ? null : sql.prepare('SELECT * FROM '+store+'_meta').get();
    sql.exec('DROP TABLE storage_migrations; DROP TABLE storage_meta');db.close();
    db = open();sql = db.connection || db.db;
    assert.equal(sql.prepare('SELECT origin FROM storage_migrations WHERE component=?').get('migrate'+store[0].toUpperCase()+store.slice(1)).origin,'legacy-baseline');
    assert.deepEqual(sql.prepare('SELECT * FROM observations').all(),before);
    if (account) assert.deepEqual(sql.prepare('SELECT * FROM '+store+'_meta').get(),account);
    if (store === 'randewoo') assert.deepEqual(db.setting('schedule'),['07:00']);
    else assert.equal(db.state().interval_minutes,120);
    db.close();
  }
});

test('foreign and incompatible storage is rejected before schema or observations change',t => {
  const sql = memory(t);sql.exec('CREATE TABLE unrelated(value TEXT)');
  assert.throws(() => assertStorage(sql,'randewoo'),/schema/);
  assert.equal(tableExists(sql,'storage_meta'),false);
  const directory = root(t),db = new OzonDatabase(directory);
  db.db.exec('UPDATE storage_meta SET format=99');
  const before = db.db.prepare('SELECT * FROM storage_migrations').all();
  assert.throws(() => new OzonDatabase(directory));
  assert.deepEqual(db.db.prepare('SELECT * FROM storage_migrations').all(),before);db.close();
});

test('row projections rebuild on formula upgrade and downgrade without rewriting source prices',t => {
  const sql = memory(t);sql.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY,sku TEXT,checked_at TEXT,price INTEGER); INSERT INTO observations VALUES(1,\'a\',\'2026-01-01\',100),(2,\'a\',\'2026-01-02\',90)');
  const source = sql.prepare('SELECT * FROM observations').all();
  const cache = (version,factor) => new RowCache(sql,{key:'sku',version,initial:() => ({sum:0}),reduce:(state,row) => {state.sum+=row.price*factor;}});
  const old = cache(1,1),next = cache(2,2);
  assert.equal(old.read(['a']).get('a').sum,190);
  assert.equal(next.read(['a']).get('a').sum,380);
  // A still-open old reader also detects the version change, not just constructors.
  assert.equal(old.read(['a']).get('a').sum,190);
  assert.deepEqual(sql.prepare('SELECT * FROM observations').all(),source);
});

test('history projections rebuild all scopes after version change and preserve errors',t => {
  const sql = memory(t);sql.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY)');
  const cache = version => new HistoryCache(sql,{version,scopes:['a','b'],sources:[]});
  const points = price => [{key:'1',stamp:'2026',position:1,point:{price,status:'error'}}];
  const old = cache(1);old.read('a','',() => points(1));old.read('b','',() => points(2));
  const next = cache(2);
  assert.equal(next.read('a','',() => points(10))[0].price,10);
  assert.equal(next.read('b','',() => points(20))[0].status,'error');
  assert.equal(old.read('a','',() => points(1))[0].price,1);
});

test('failed projection rebuild retains the previous result and its version for retry',t => {
  const sql = memory(t);sql.exec("CREATE TABLE observations(id INTEGER PRIMARY KEY,sku TEXT,checked_at TEXT,price INTEGER); INSERT INTO observations VALUES(1,'a','2026',100)");
  const old = new RowCache(sql,{key:'sku',version:1,initial:() => ({price:null}),reduce:(state,row) => {state.price = row.price;}});
  old.read(['a']);const saved = sql.prepare('SELECT * FROM price_rows').all();
  const next = new RowCache(sql,{key:'sku',version:2,initial:() => ({}),reduce:() => {throw new Error('injected calculation failure');}});
  assert.throws(() => next.read(['a']),/injected/);
  assert.deepEqual(sql.prepare('SELECT * FROM price_rows').all(),saved);
  assert.equal(sql.prepare("SELECT version FROM projection_versions WHERE name='price_rows'").get().version,'1');
});

test('published snapshot version cannot expose unfinished collection or silently discard its saved result',t => {
  const sql = memory(t);sql.exec("CREATE TABLE checks(status TEXT); CREATE TABLE observations(id INTEGER PRIMARY KEY)");
  const old = new CollectionSnapshot(sql,{scopes:['a'],build:() => ({items:[]}),version:1});
  old.start(() => sql.exec("INSERT INTO checks VALUES('running')"));
  const saved = sql.prepare('SELECT * FROM collection_snapshot').all();
  const next = new CollectionSnapshot(sql,{scopes:['a'],build:() => ({items:[]}),version:2});
  assert.throws(() => next.dashboard('a'),/requires_idle/);
  assert.deepEqual(sql.prepare('SELECT * FROM collection_snapshot').all(),saved);
  sql.exec("UPDATE checks SET status='interrupted'");
  assert.deepEqual(next.dashboard('a'),{items:[]});
});

test('offline preparation journals auxiliary tables, preserves schedules and reports every store',t => {
  const directory = root(t),db = new Database(join(directory,'.data/prices.sqlite3'));
  db.setSetting('schedule',['12:00']);db.close();new OzonDatabase(directory).close();new LamodaDatabase(directory).close();
  const result = prepareStores(directory);assert.equal(result.ok,true);assert.equal(Object.keys(result.stores).length,3);
  assert.equal(prepareStores(directory).ok,true);
  const reopened = new Database(join(directory,'.data/prices.sqlite3'));assert.deepEqual(reopened.setting('schedule'),['12:00']);
  assert.ok(reopened.get("SELECT 1 FROM storage_migrations WHERE component='migrateCodex'"));reopened.close();
  const lamoda = new LamodaDatabase(directory);
  assert.ok(lamoda.db.prepare("SELECT 1 FROM storage_migrations WHERE component='migratePush'").get());lamoda.close();
});

test('readiness distinguishes unavailable stores from account and network failures',t => {
  const directory = root(t),db = new Database(join(directory,'.data/prices.sqlite3'));
  const services = {randewoo:{db},ozon:null};warmRuntime(services);
  assert.equal(runtimeReadiness(services,['randewoo']).ok,true);
  assert.equal(runtimeReadiness(services,['randewoo','ozon']).ok,false);
  assert.equal(checkStores(directory,{stores:['ozon']}).ok,false);
  db.close();
});

test('deployment pause prevents new collection operations without changing persistent settings',async t => {
  const directory = root(t),db = new Database(join(directory,'.data/prices.sqlite3'));db.close();
  const queue = new CollectionQueue(directory);writeFileSync(join(directory,'.data/deployment.json'),'{}');
  let called = false;
  await assert.rejects(queue.enqueue('ozon',() => {called = true;}).done,/обновления/);
  assert.equal(called,false);
});

test('deployment pause lets admitted work finish while refusing another store',async t => {
  const directory = root(t),queue = new CollectionQueue(directory),finished = Promise.withResolvers();
  const active = queue.enqueue('randewoo',() => finished.promise);await active.ready;
  writeFileSync(join(directory,'.data/deployment.json'),'{}');
  await assert.rejects(queue.enqueue('ozon',() => {throw new Error('must not run');}).done,/обновления/);
  finished.resolve('saved');assert.equal(await active.done,'saved');
});

test('maintenance process owns all writer locks until its worker finishes and release is acknowledged',{timeout:30000},async t => {
  const directory = root(t);new Database(join(directory,'.data/prices.sqlite3')).close();
  const child = spawn(process.execPath,['scripts/storage-maintenance.js','hold',directory],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited = once(child,'exit'),lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  child.stderr.resume();
  try {
    const locked = JSON.parse((await lines.next()).value);assert.equal(locked.locked,true);
    for (const path of ['app.lock','ozon/collector.lock','lamoda/collector.lock','collection.lock']) {
      await assert.rejects(acquireInstance(join(directory,'.data',path)),AlreadyRunning);
    }
    child.stdin.write('prepare\n');
    assert.equal(JSON.parse((await lines.next()).value).ok,true);
    await assert.rejects(acquireInstance(join(directory,'.data/collection.lock')),AlreadyRunning);
    child.stdin.end('release\n');assert.equal((await exited)[0],0);
    const release = await acquireInstance(join(directory,'.data/app.lock'));await release();
    assert.equal(checkStores(directory,{legacy:false}).ok,true);
  } finally {
    if (child.exitCode === null) {child.kill();await exited;}
    await lines.return();
  }
});
