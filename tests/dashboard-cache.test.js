import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Database} from '../src/database.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {LamodaDesktop} from '../src/providers/lamoda/desktop.js';
import {compositionKey} from '../src/dashboard-cache.js';
import {checkMessage} from '../src/telegram.js';
import {temporary,cleanup,item} from './helpers.js';

const stamp = n => new Date(Date.UTC(2026,9,1,0,n)).toISOString();
function store(t,path = ':memory:') {
  const db = new Database(path);
  if (path === ':memory:') t.after(() => db.close());else cleanup(t,() => db.close());
  const id = db.variant(item());db.syncList('favorites',[[id,1]],stamp(0));
  return {db,id};
}
function finish(db,id,status = 'success') {db.updateCheck(id,{status,finished_at:stamp(90)});}

test('row summaries consume only new observations and survive corrections, old imports and deletes', t => {
  const {db,id} = store(t);
  for (let n=1;n<=50;n++) db.observation(id,item({price_kopecks:n<10 ? 10000 : 9000}),'public',null,stamp(n));
  const reduce = t.mock.method(db.rowCache,'reduce');
  let row = db.rows('favorites')[0];
  assert.equal(reduce.mock.callCount(),50);assert.equal(row.last_change.checked_at,stamp(10));
  db.rows('favorites');assert.equal(reduce.mock.callCount(),50);
  db.observation(id,item({price_kopecks:9000}),'public',null,stamp(51));
  row = db.rows('favorites')[0];assert.equal(reduce.mock.callCount(),51);
  assert.equal(row.last_change.checked_at,stamp(10));assert.equal(row.observations,51);
  db.observation(id,item({price_kopecks:8000}),'public',null,stamp(5));
  row = db.rows('favorites')[0];assert.equal(row.minimum,8000);assert.equal(row.price,9000);
  assert.equal(row.last_change.checked_at,stamp(10));assert.equal(row.observations,52);
  db.run('UPDATE observations SET price=7000 WHERE id=51');
  row = db.rows('favorites')[0];assert.equal(row.price,7000);assert.equal(row.last_change.checked_at,stamp(51));
  db.run('DELETE FROM observations WHERE id=51');
  row = db.rows('favorites')[0];assert.equal(row.price,9000);assert.equal(row.minimum,8000);
  assert.equal(row.last_change.checked_at,stamp(10));
});

test('a transaction rollback rolls back derived rows and projections with their source', t => {
  const {db,id} = store(t);db.observation(id,item(),'public',null,stamp(1));
  const before = db.rows('favorites');const graph = db.listHistory('favorites','public',0);
  assert.throws(() => db.transaction(() => {
    db.observation(id,item({price_kopecks:1}),'public',null,stamp(2));
    assert.equal(db.rows('favorites')[0].price,1);
    assert.equal(db.listHistory('favorites','public',0).length,2);
    throw Error('rollback');
  }),/rollback/);
  assert.deepEqual(db.rows('favorites'),before);
  assert.deepEqual(db.listHistory('favorites','public',0),graph);
});

test('source writes from another connection invalidate persistent caches across restart', t => {
  const path = join(temporary(t),'prices.sqlite3'),{db,id} = store(t,path);
  db.observation(id,item(),'public',null,stamp(1));db.rows('favorites');db.listHistory('favorites','public',0);
  const writer = new Database(path);cleanup(t,() => writer.close());
  writer.observation(id,item({price_kopecks:12000}),'public',null,stamp(2));
  assert.equal(db.rows('favorites')[0].price,12000);
  assert.equal(db.listHistory('favorites','public',0).at(-1).price,12000);
  const reopened = new Database(path);cleanup(t,() => reopened.close());
  const build = t.mock.method(reopened,'buildListHistory');
  assert.equal(reopened.listHistory('favorites','public',0).length,2);
  assert.equal(build.mock.callCount(),0,'stored graph points survive reopening');
});

test('overview is published after every terminal status and unchanged history is never rebuilt', t => {
  const {db,id} = store(t);
  for (const [n,status] of ['success','partial','error','interrupted'].entries()) {
    const check = db.startCheck('manual',stamp(n+1));
    db.observation(id,status === 'success' ? item() : {status:'error',message:'Synthetic failure'},'public',check,stamp(n+1));
    assert.equal(db.listHistory('favorites','public',0).length,n,'unfinished checks have no final point');
    const build = t.mock.method(db,'buildListHistory');finish(db,check,status);
    const selected = build.mock.calls.filter(call => call.arguments[0] === 'favorites' && call.arguments[1] === 'public');
    assert.equal(selected.length,1);assert.deepEqual(selected[0].arguments[2],['c:'+check]);
    build.mock.restore();
    const cached = t.mock.method(db,'buildListHistory');
    const points = db.listHistory('favorites','public',0);
    assert.equal(points.length,n+1);assert.equal(points.at(-1).status,status === 'success' ? 'ok' : 'error');
    assert.equal(cached.mock.callCount(),0);cached.mock.restore();
  }
  db.run('UPDATE observations SET price=17000 WHERE id=1');
  assert.equal(db.listHistory('favorites','public',0)[0].price,17000);
  db.run('DELETE FROM observations WHERE id=1');
  assert.equal(db.listHistory('favorites','public',0).length,3);
});

test('compact compositions retain quantity, seller and priced-membership boundaries', () => {
  const composition = [Array.from({length:1000},(_,i) => [String(i),1]),[['1','seller']]];
  assert.ok(compositionKey(composition).length < 50);
  assert.equal(compositionKey(composition),compositionKey(JSON.stringify(composition)));
  for (const changed of [[[[0,2]],composition[1]],[composition[0],[['1','other']]],[composition[0],[]]]) {
    assert.notEqual(compositionKey(composition),compositionKey(changed));
  }
});

test('Ozon repairs cached historical points and rows without inventing global failure observations', t => {
  const db = new OzonDatabase(temporary(t));cleanup(t,() => db.close());
  const product = {external_id:'123',url:'https://www.ozon.ru/product/123/',title:'Synthetic',availability:'available',listed_price_kopecks:10000};
  const first = db.begin('manual',stamp(1));db.recordFavorites(first,[product],stamp(1));db.finish(first,'success','',stamp(1));
  db.dashboard();
  db.db.prepare('UPDATE observations SET listed_price_kopecks=8000 WHERE check_id=?').run(first);
  assert.equal(db.dashboard().items[0].price_summary.listed.minimum,8000);
  assert.equal(db.listHistory('favorites',0)[0].listed.known_total,8000);
  const failed = db.begin('manual',stamp(2));db.finish(failed,'error','Synthetic failure',stamp(2));
  assert.equal(db.listHistory('favorites',0).length,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM observations').get().n,1);
});

test('Lamoda materializes empty failed checks and rebuilds a repaired observation', t => {
  const db = new LamodaDatabase(temporary(t));cleanup(t,() => db.close());
  const check = db.begin('manual',new Date().toISOString());db.failure(check,'Synthetic failure',new Date().toISOString());
  assert.equal(db.dashboard().history[0].status,'error');assert.equal(db.dashboard().history[0].count,0);
  const next = db.begin('manual',new Date().toISOString());
  db.record(next,[{sku:'ABCDEF',title:'Synthetic',color:'',url:'https://www.lamoda.ru/p/abcdef/',image_url:null,price:10000,original_price:12000,availability:'available'}],new Date().toISOString());
  db.dashboard();db.db.prepare('UPDATE observations SET price=9000 WHERE check_id=?').run(next);
  assert.equal(db.dashboard().items[0].minimum,9000);assert.equal(db.dashboard().history.at(-1).price,9000);
});

test('Telegram finds the selected Randewoo check and previous prices through indexes', t => {
  const {db,id} = store(t);let check;
  for (let n=1;n<=3;n++) {check = db.startCheck('manual',stamp(n));db.observation(id,item({price_kopecks:10000-n*100}),'public',check,stamp(n));finish(db,check);}
  let query;const original = db.all.bind(db);
  t.mock.method(db,'all',(sql,...args) => {if (sql.includes('FROM observations current')) query = [sql,args];return original(sql,...args);});
  checkMessage(db,db.get('SELECT * FROM checks WHERE id=?',check));
  const plan = original('EXPLAIN QUERY PLAN '+query[0],...query[1]).map(row => row.detail).join('\n');
  assert.match(plan,/SEARCH current USING INDEX observation_check/);
  assert.match(plan,/SEARCH old USING INDEX observation_previous/);
  assert.doesNotMatch(plan,/SCAN current|TEMP B-TREE FOR ORDER BY/);
});

test('desktop summaries preserve the existing order of simultaneous snapshots', t => {
  const db = new LamodaDatabase(temporary(t));cleanup(t,() => db.close());
  const desktop = new LamodaDesktop(db),at = new Date().toISOString();
  const product = {sku:'ABCDEF',title:'Synthetic',color:'',url:'https://www.lamoda.ru/p/abcdef/',image_url:null,original_price:12000,availability:'available'};
  for (const [run,price] of [['z',10000],['a',11000]]) {
    db.db.prepare('INSERT INTO desktop_snapshots VALUES(?,?,?,?,?,?)').run(run,at,'synthetic',1,'synthetic','[]');
    desktop.history.index(run,at,[{...product,price}]);
    const row = desktop.dashboard().items[0];
    const latest = db.db.prepare('SELECT * FROM desktop_observations WHERE sku=? ORDER BY checked_at DESC LIMIT 1').get(product.sku);
    const sparkline = db.db.prepare('SELECT price FROM desktop_observations WHERE sku=? ORDER BY checked_at DESC LIMIT 24').all(product.sku).reverse();
    assert.equal(row.price,latest.price);assert.deepEqual(row.sparkline.map(point => point.price),sparkline.map(point => point.price));
  }
  assert.deepEqual(desktop.dashboard().history.map(point => point.price),[11000,10000]);
});
