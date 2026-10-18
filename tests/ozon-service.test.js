import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from '../src/database.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {OzonClient} from '../src/providers/ozon/client.js';
import {OzonSession} from '../src/providers/ozon/session.js';
import {OZON_INTERVAL_MS} from '../src/providers/ozon/probe.js';
import {temporary, cleanup, item} from './helpers.js';
import {TEST_OZON_URL, connectTestOzon, ozonPage, jsonResponse} from './ozon-fixture.js';

test('real HTTP pipeline persists two prices, survives restart, marks seller changes and preserves prices on 403', async t => {
  const root = temporary(t), randewoo = new Database(join(root,'.data/prices.sqlite3'));
  randewoo.variant(item()); randewoo.close();
  const before = readFileSync(join(root,'.data/prices.sqlite3'));
  await connectTestOzon(root);
  let now = Date.now(), seller = '55', blocked = false, calls = 0;
  const client = () => new OzonClient(root,{fetchImpl:async (url,options) => {
    calls++; assert.equal(options.method,'GET'); assert.equal(options.redirect,'manual'); assert.match(options.headers.cookie,/synthetic-session/);
    assert.equal(new URL(url).origin,'https://www.ozon.ru');
    if (new URL(url).searchParams.get('url').startsWith('/product/')) assert.equal(new URL(url).searchParams.get('url'),'/product/test-item-123/');
    return blocked ? new Response('private-response',{status:403}) : jsonResponse(ozonPage({seller}));
  }});
  let service = new OzonService(root,{client:client(),current:() => now});
  const id = service.watch(TEST_OZON_URL);
  assert.equal(service.status().schedule_enabled,false);
  await service.start({id}); await service.running;
  assert.equal(calls,2);
  let detail = service.db.detail(id,0);
  assert.equal(detail.product.regular_kopecks,100000); assert.equal(detail.product.ozon_card_kopecks,90000);
  assert.equal(detail.product.seller_id,'55'); assert.equal(detail.points.length,1);
  assert.equal(detail.product.url,TEST_OZON_URL);
  await assert.rejects(service.start({id}),/пауза/);
  assert.equal(calls,2);
  await service.close();
  now += OZON_INTERVAL_MS + 1; seller = '66';
  service = new OzonService(root,{client:client(),current:() => now});
  cleanup(t,() => service.close());
  await service.start({id}); await service.running;
  detail = service.db.detail(id,0,now);
  assert.equal(detail.points.length,2); assert.equal(detail.seller_events.length,1);
  assert.deepEqual([detail.seller_events[0].old_name,detail.seller_events[0].new_name],['Продавец 55','Продавец 66']);
  now += OZON_INTERVAL_MS + 1; blocked = true;
  const previousCalls = calls;
  await service.start({id}); await service.running;
  assert.equal(calls-previousCalls,1);
  detail = service.db.detail(id,0,now);
  assert.equal(detail.product.status,'error'); assert.equal(detail.product.ozon_card_kopecks,90000);
  assert.equal(detail.points.at(-1).ozon_card_kopecks,null);
  assert.equal(detail.seller_events.length,1);
  assert.equal(service.status().action_required,true);
  assert.doesNotMatch(JSON.stringify(service.status()),/synthetic-session|Synthetic test address|account_id|delivery_digest|private-response/);
  now += 86400000; await assert.rejects(service.start({id}),/приостановлены/);
  assert.deepEqual(readFileSync(join(root,'.data/prices.sqlite3')),before);
});

test('wrong account and incomplete lists cannot overwrite existing membership or save a new price', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let mode = 'wrong';
  const service = new OzonService(root,{client:new OzonClient(root,{fetchImpl:async () => {
    const page = ozonPage({account:mode === 'wrong' ? 999 : 123});
    if (mode === 'partial') delete page.nextPage;
    return jsonResponse(page);
  }})});
  cleanup(t,() => service.close());
  const id = service.watch(TEST_OZON_URL);
  service.db.syncLists([{external_id:'123',url:TEST_OZON_URL,title:'Saved favorite'}],[],new Date().toISOString());
  await service.start({id}); await service.running;
  assert.equal(service.db.detail(id,0).points[0].status,'error');
  assert.equal(service.db.dashboard('favorites').items.length,1);
  service.db.updateState({not_before:null,action_required:0}); mode = 'partial';
  await service.start(); await service.running;
  assert.equal(service.db.dashboard('favorites').items[0].title,'Saved favorite');
  assert.equal(service.status().checks[0].status,'error');
});

test('schedule is opt-in, respects the two-hour delay and never overlaps a manual check', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let now = Date.now(), calls = 0;
  const service = new OzonService(root,{current:() => now,client:new OzonClient(root,{fetchImpl:async () => {calls++; return jsonResponse(ozonPage());}})});
  cleanup(t,() => service.close());
  await service.startScheduler(); await service.tick(); assert.equal(calls,0);
  service.settings({schedule_enabled:true});
  await service.tick(); assert.equal(calls,0);
  now += OZON_INTERVAL_MS+1;
  await service.tick(); await service.running;
  assert.equal(calls,2); // Empty but complete favorites and cart; no product requests.
  assert.equal(service.status().checks[0].trigger,'schedule');
  service.settings({schedule_enabled:false}); now += 86400000; await service.tick(); assert.equal(calls,2);
});

test('an interrupted persisted check remains blocked on restart and a foreign database is rejected without writes', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let service = new OzonService(root);
  service.db.begin('manual',new Date().toISOString()); await service.close();
  service = new OzonService(root); cleanup(t,() => service.close());
  await service.startScheduler();
  assert.equal(service.status().action_required,true);
  assert.equal(service.status().checks[0].status,'interrupted');
  const foreignRoot = temporary(t); mkdirSync(join(foreignRoot,'.data/ozon'),{recursive:true});
  const file = join(foreignRoot,'.data/ozon/prices.sqlite3');
  const db = new Database(file); db.variant(item()); db.close();
  const before = readFileSync(file);
  assert.throws(() => new OzonDatabase(foreignRoot),/Randewoo/);
  assert.deepEqual(readFileSync(file),before);
});

test('browser-cookie import selects only the Ozon first-party partition and respects absolute expiry after restart', async t => {
  const root = temporary(t); let now = Date.now();
  const cookie = {name:'partition',value:'synthetic-partition',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,expires:(now+30000)/1000,session:false,
    partitionKey:{topLevelSite:'https://ozon.ru',hasCrossSiteAncestor:false}};
  await connectTestOzon(root,{cookies:[cookie,{...cookie,name:'foreign',partitionKey:{topLevelSite:'https://other.test',hasCrossSiteAncestor:true}}],current:() => now});
  let session = await OzonSession.open(join(root,'.secrets/ozon/session.json'),'bootstrap=disabled',{current:() => now});
  const url = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2F123%2F';
  assert.equal(await session.header(url),'partition=synthetic-partition');
  now += 31000;
  session = await OzonSession.open(join(root,'.secrets/ozon/session.json'),'bootstrap=disabled',{current:() => now});
  assert.equal(await session.header(url),'');
  await assert.rejects(connectTestOzon(root,{cookies:[{...cookie,partitionKeyOpaque:true}]}),/область/);
});
