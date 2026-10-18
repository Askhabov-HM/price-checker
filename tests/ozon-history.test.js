import test from 'node:test';
import assert from 'node:assert/strict';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {temporary,cleanup} from './helpers.js';

const product = (sku, regular = 10000, card = 9000, seller = '55') => ({external_id:sku,
  url:'https://www.ozon.ru/product/'+sku+'/',title:'Synthetic product '+sku,availability:'available',
  prices:{regular_kopecks:regular,ozon_card_kopecks:card},seller:{external_id:seller,name:'Synthetic seller '+seller}});
const stamp = hour => `2026-10-18T${String(hour).padStart(2,'0')}:00:00.000Z`;
function database(t) {const db = new OzonDatabase(temporary(t));cleanup(t,() => db.close());return db;}
function run(db, hour, products) {
  const check = db.begin('manual',stamp(hour));db.snapshotLists(check);
  for (const item of products) db.observe(check,item,stamp(hour));
  db.finish(check,'success','',stamp(hour));return check;
}

test('list history preserves the actual membership, quantity and seller of each check across later changes and restart', t => {
  const root = temporary(t);let db = new OzonDatabase(root);cleanup(t,() => db.close());
  const a = product('123'), b = product('456',20000,18000);
  db.syncLists([a,b],[{...a,quantity:3},b],stamp(1));
  run(db,2,[a,b]);
  const first = db.listHistory('cart',0)[0];
  assert.equal(first.count,2);assert.equal(first.regular.known_total,50000);assert.equal(first.ozon_card.known_total,45000);
  assert.equal(first.regular.complete,true);assert.equal(db.listHistory('favorites',0)[0].regular.known_total,30000);
  db.syncLists([a],[{...a,quantity:2}],stamp(3));
  run(db,4,[a]);
  let points = db.listHistory('cart',0);
  assert.deepEqual(points[0],first);assert.equal(points[1].count,1);assert.equal(points[1].regular.known_total,20000);
  assert.notEqual(points[0].regular.composition,points[1].regular.composition);
  run(db,6,[product('123',10000,9000,'66')]);
  points = db.listHistory('cart',0);
  assert.equal(points[1].regular.known_total,points[2].regular.known_total);
  assert.notEqual(points[1].regular.composition,points[2].regular.composition);
  db.close();db = new OzonDatabase(root);
  assert.deepEqual(db.listHistory('cart',0),points);
});

test('partial and failed checks never add an old price or an unavailable item to the fresh total', t => {
  const db = database(t), a = product('123'), b = product('456',20000,18000);
  db.syncLists([a,b],[],stamp(1));run(db,2,[a,b]);
  const check = db.begin('manual',stamp(4));db.snapshotLists(check);
  db.observe(check,product('123',11000,null),stamp(4));
  db.failure(check,'456','Synthetic failure',stamp(4));db.finish(check,'error','Synthetic failure',stamp(4));
  let last = db.listHistory('favorites',0).at(-1);
  assert.equal(last.regular.known_total,11000);assert.equal(last.regular.priced_count,1);
  assert.equal(last.regular.status,'error');assert.equal(last.regular.complete,false);
  assert.equal(last.ozon_card.priced_count,0);assert.equal(last.ozon_card.known_total,0);
  assert.equal(db.dashboard('favorites').items[1].regular_kopecks,20000);
  run(db,6,[a,{...b,availability:'out_of_stock',prices:{regular_kopecks:null,ozon_card_kopecks:null}}]);
  last = db.listHistory('favorites',0).at(-1);
  assert.equal(last.regular.known_total,10000);assert.equal(last.regular.priced_count,1);
  assert.equal(last.regular.status,'missing');assert.equal(last.regular.complete,false);
});

test('unfinished runs and legacy observations with unknown list membership do not invent overview points', t => {
  const db = database(t), a = product('123');db.syncLists([a],[],stamp(1));
  const legacy = db.begin('browser',stamp(2));db.observe(legacy,a,stamp(2));db.finish(legacy,'success','',stamp(2));
  assert.deepEqual(db.listHistory('favorites',0),[]);
  const active = db.begin('manual',stamp(4));db.snapshotLists(active);db.observe(active,a,stamp(4));
  assert.deepEqual(db.listHistory('favorites',0),[]);
  db.finish(active,'success','',stamp(4));assert.equal(db.listHistory('favorites',0).length,1);
  assert.equal(db.dashboard('favorites').items[0].sparkline.length,2);
  assert.equal(db.listHistory('favorites',7,Date.parse(stamp(4))+8*86400000).length,0);
});
