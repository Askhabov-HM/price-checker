import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Database} from '../src/database.js';
import {CollectionSnapshot} from '../src/collection-snapshot.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {temporary,cleanup,item} from './helpers.js';

const stamp = new Date().toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
for (const outcome of ['success','partial','error','interrupted']) test(`Randewoo publishes previous data until ${outcome}, including membership and detail history`,t => {
  const db = new Database(join(temporary(t),'prices.sqlite3'));cleanup(t,() => db.close());
  const id = db.variant(item());db.syncList('favorites',[[id,1]],stamp);
  db.observation(id,item(),'public',null,stamp);
  const dashboard = plain(db.publishedDashboard('favorites','public'));
  const detail = plain(db.publishedDetail(id,'public',0));
  const check = db.startCheck('manual',stamp);
  db.observation(id,item({price_kopecks:19000}),'public',check,stamp);
  db.variant(item({name:'Changed during collection'}));
  db.syncList('favorites',[],stamp);
  assert.deepEqual(plain(db.publishedDashboard('favorites','public')),dashboard);
  assert.deepEqual(plain(db.publishedDetail(id,'public',0)),detail);
  assert.equal(db.detail(id,'public',0).points.length,2);
  db.updateCheck(check,{status:outcome,finished_at:stamp});
  assert.equal(db.publishedDashboard('favorites','public').items.length,0);
  assert.equal(db.publishedDetail(id,'public',0).points.length,2);
});

const ozon = (price,title='Saved product') => ({external_id:'123',url:'https://www.ozon.ru/product/123/',
  title,availability:'available',listed_price_kopecks:price,original_price_kopecks:20000});
test('Ozon shares the published result with a second connection, preserves seller events and releases on failure',t => {
  const root = temporary(t),db = new OzonDatabase(root);cleanup(t,() => db.close());
  const first = db.begin('manual',stamp);db.recordFavorites(first,[ozon(10000)],stamp);db.finish(first,'success','',stamp);
  const expected = plain(db.publishedDashboard());
  const detail = plain(db.publishedDetail('ozon:item:123',0));
  const check = db.begin('manual',stamp);
  db.recordFavorites(check,[ozon(12000,'Changed')],stamp);
  db.db.prepare('INSERT INTO seller_events(sku,checked_at,old_id,new_id,old_name,new_name) VALUES(?,?,?,?,?,?)').run('123',stamp,'1','2','Old','New');
  const reader = new OzonDatabase(root);cleanup(t,() => reader.close());
  assert.deepEqual(plain(reader.publishedDashboard()),expected);
  assert.deepEqual(plain(reader.publishedDetail('ozon:item:123',0)),detail);
  assert.throws(() => reader.publishedDashboard('invalid'));
  db.finish(check,'error','Synthetic terminal error',stamp);
  assert.equal(reader.publishedDashboard().items[0].listed_price_kopecks,12000);
  assert.equal(reader.publishedDetail('ozon:item:123',0).points.length,2);
  assert.equal(reader.publishedDetail('ozon:item:123',0).seller_events.length,1);
});

const lamoda = {sku:'SYNTHETIC001',title:'Saved product',color:'blue',url:'https://www.lamoda.ru/p/synthetic001/',
  image_url:null,price:10000,original_price:20000,availability:'available'};
test('Lamoda opens the previous dashboard and detail during collection, then publishes interruption',t => {
  const root = temporary(t),db = new LamodaDatabase(root);cleanup(t,() => db.close());
  db.record(db.begin('manual',stamp),[lamoda],stamp);
  const expected = plain(db.publishedDashboard()),detail = plain(db.publishedDetail('lamoda:item:SYNTHETIC001',0));
  db.begin('manual',stamp);
  const reader = new LamodaDatabase(root);cleanup(t,() => reader.close());
  assert.deepEqual(plain(reader.publishedDashboard()),expected);
  assert.deepEqual(plain(reader.publishedDetail('lamoda:item:SYNTHETIC001',0)),detail);
  db.recover(stamp);
  assert.equal(reader.publishedDashboard().items[0].status,'error');
  assert.equal(reader.publishedDetail('lamoda:item:SYNTHETIC001',0).points.length,2);
});

test('the first ever collection serves an empty previous result until it finishes',t => {
  const db = new OzonDatabase(temporary(t));cleanup(t,() => db.close());
  const check = db.begin('manual',stamp);db.recordFavorites(check,[ozon(10000)],stamp);
  assert.equal(db.publishedDashboard().items.length,0);
  db.finish(check,'success','',stamp);
  assert.equal(db.publishedDashboard().items.length,1);
});

test('snapshot failure rolls back the boundary and does not start a collection',() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE checks(status TEXT); CREATE TABLE observations(id INTEGER PRIMARY KEY)');
    let fail = false;
    const snapshot = new CollectionSnapshot(db,{scopes:['a','b'],build:scope => {
      if (fail && scope === 'b') throw new Error('Synthetic snapshot failure');
      return {items:[],value:fail ? 'new' : 'previous'};
    }});
    snapshot.start(() => {});fail = true;
    assert.throws(() => snapshot.start(() => db.exec("INSERT INTO checks VALUES('running')")),/Synthetic/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checks').get().n,0);
    assert.equal(snapshot.saved('a').data.value,'previous');
  } finally {db.close();}
});
