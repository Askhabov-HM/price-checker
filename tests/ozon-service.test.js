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
import {acquireInstance} from '../src/instance.js';
import {temporary, cleanup, item} from './helpers.js';
import {TEST_OZON_URL, connectTestOzon, ozonPage, jsonResponse, favoriteTile,responseBrowser} from './ozon-fixture.js';

test('a scheduled 403 exhausts three retries and tries again at the next existing interval', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let now = Date.parse('2026-10-20T10:00:00Z'), blocked = true, calls = 0;
  const service = new OzonService(root,{pause:async () => {},current:() => now,client:new OzonClient(root,{browser:responseBrowser(async () => {
    calls++; return blocked ? new Response('',{status:403}) : jsonResponse(ozonPage());
  })})});
  cleanup(t,() => service.close());
  service.settings({schedule_enabled:true,interval_minutes:60});
  const anchor = service.status().schedule_anchor;
  now = Date.parse(service.status().next_check)+1;
  await service.tick(); await service.running;
  assert.equal(calls,4); assert.equal(service.status().checks[0].status,'error');
  assert.equal(service.status().action_required,false); assert.equal(service.status().schedule_enabled,true);
  assert.equal(service.status().next_check,'2026-10-20T12:00:00.000Z');
  await service.tick(); assert.equal(calls,4);
  blocked = false; now = Date.parse(service.status().next_check)+1;
  await service.tick(); await service.running;
  assert.equal(calls,5); assert.equal(service.status().checks[0].status,'success');
  assert.equal(service.status().schedule_anchor,anchor);
});

test('Retry-After chooses an allowed scheduled slot in either scheduling mode', async t => {
  for (const mode of ['interval','hours']) {
    const root = temporary(t); await connectTestOzon(root);
    let now = Date.parse('2026-10-20T10:00:00Z'), calls = 0;
    const service = new OzonService(root,{current:() => now,client:new OzonClient(root,{browser:responseBrowser(async () => {
      calls++;return new Response('',{status:429,headers:{'Retry-After':'7200'}});
    })})});
    cleanup(t,() => service.close());
    service.settings({schedule_enabled:true,schedule_mode:mode,interval_minutes:60,schedule:['14:00','15:00','16:00']});
    await service.start(); await service.running;
    assert.equal(service.status().not_before,'2026-10-20T12:00:00.000Z');
    assert.equal(Date.parse(service.status().next_check),Date.parse('2026-10-20T12:00:00Z'));
    assert.equal(service.status().action_required,false);
    now += 3600000;await service.tick();assert.equal(calls,1);
    now += 3600000;await service.tick();await service.running;assert.equal(calls,2);
  }
});

test('startup resumes a legacy 403 pause but preserves login and account pauses', async t => {
  for (const [message,blocked] of [['Ozon ограничил доступ. Проверки приостановлены.',false],
    ['Нужно обновить вход в Ozon.',true],['Аккаунт Ozon не подтверждён. Проверки приостановлены.',true]]) {
    const root = temporary(t); await connectTestOzon(root);
    const now = Date.parse('2026-10-20T10:00:00Z');
    const service = new OzonService(root,{current:() => now});cleanup(t,() => service.close());
    service.settings({schedule_enabled:true,interval_minutes:60});
    service.db.updateState({action_required:1,message,next_check:null});
    service.login.require = async () => {};
    await service.startScheduler();
    assert.equal(service.status().action_required,blocked);
    assert.equal(service.status().next_check,blocked ? null : '2026-10-20T11:00:00.000Z');
  }
});

test('the browser pipeline persists two prices, survives restart, marks seller changes and preserves prices on 403', async t => {
  const root = temporary(t), randewoo = new Database(join(root,'.data/prices.sqlite3'));
  randewoo.variant(item()); randewoo.close();
  const before = readFileSync(join(root,'.data/prices.sqlite3'));
  await connectTestOzon(root);
  let now = Date.now(), seller = '55', blocked = false, calls = 0;
  const client = () => new OzonClient(root,{browser:responseBrowser(async (url,options) => {
    calls++; assert.equal(options.credentials,'include');assert.equal(options.redirect,'error');
    assert.equal(new URL(url).origin,'https://www.ozon.ru');
    if (new URL(url).searchParams.get('url').startsWith('/product/')) assert.equal(new URL(url).searchParams.get('url'),'/product/test-item-123/');
    return blocked ? new Response('private-response',{status:403}) : jsonResponse(ozonPage({seller}));
  })});
  let service = new OzonService(root,{pause:async () => {},client:client(),current:() => now});
  const id = service.watch(TEST_OZON_URL);
  assert.equal(service.status().schedule_enabled,false);
  await service.start({id}); await service.running;
  assert.equal(calls,2);
  let detail = service.db.detail(id,0);
  assert.equal(detail.product.regular_kopecks,100000); assert.equal(detail.product.ozon_card_kopecks,90000);
  assert.equal(detail.product.seller_id,'55'); assert.equal(detail.points.length,1);
  assert.equal(detail.product.url,TEST_OZON_URL);
  assert.equal(service.status().not_before,null);
  await service.start({id});await service.running;
  assert.equal(calls,4);
  await service.close();
  now += OZON_INTERVAL_MS + 1; seller = '66';
  service = new OzonService(root,{pause:async () => {},client:client(),current:() => now});
  cleanup(t,() => service.close());
  await service.start({id}); await service.running;
  detail = service.db.detail(id,0,now);
  assert.equal(detail.points.length,3); assert.equal(detail.seller_events.length,1);
  assert.deepEqual([detail.seller_events[0].old_name,detail.seller_events[0].new_name],['Продавец 55','Продавец 66']);
  now += OZON_INTERVAL_MS + 1; blocked = true;
  const previousCalls = calls;
  await service.start({id}); await service.running;
  assert.equal(calls-previousCalls,4);
  detail = service.db.detail(id,0,now);
  assert.equal(detail.product.status,'error'); assert.equal(detail.product.ozon_card_kopecks,90000);
  assert.equal(detail.points.at(-1).ozon_card_kopecks,null);
  assert.equal(detail.seller_events.length,1);
  assert.equal(service.status().action_required,false);
  assert.doesNotMatch(JSON.stringify(service.status()),/synthetic-session|Synthetic test address|account_id|delivery_digest|private-response/);
  now += 86400000; await service.start({id}); await service.running;
  assert.equal(calls-previousCalls,8);
  assert.deepEqual(readFileSync(join(root,'.data/prices.sqlite3')),before);
});

test('only an explicit source pause creates a manual backoff; errors do not latch collection',async t => {
  for (const [status,retry,wait] of [[503,null,0],[403,'120',120000],[429,null,0],[429,'30000',30000000]]) {
    const root=temporary(t);await connectTestOzon(root);const now=Date.now();
    const service=new OzonService(root,{pause:async () => {},current:() => now,client:new OzonClient(root,{browser:responseBrowser(async () =>
      new Response('',{status,headers:retry ? {'Retry-After':retry} : {}}))})});
    cleanup(t,() => service.close());const id=service.watch(TEST_OZON_URL);await service.start({id});await service.running;
    assert.equal(service.status().not_before,wait ? new Date(now+wait).toISOString() : null);
    assert.equal(service.status().schedule_enabled,false);
    assert.equal(service.status().action_required,false);
  }
});

test('a full refresh saves both favorites prices without reading cards, cart or delivery',async t => {
  const root=temporary(t);await connectTestOzon(root);const calls=[];
  const client=new OzonClient(root,{browser:responseBrowser(async url => {
    const page=new URL(url).searchParams.get('url');
    calls.push(page);assert.equal(page,'/my/favorites?sorting=last_added');
    const data=ozonPage();delete data.location;delete data.widgetStates['addressBookBarWeb-1-default-1'];
    data.widgetStates['tileGridDesktop-8-default-1']=JSON.stringify({items:[favoriteTile(),favoriteTile('456',{price:'1 373 ₽',original:null})]});
    return jsonResponse(data);
  })});
  const service=new OzonService(root,{client,pause:async () => {}});cleanup(t,() => service.close());
  const first=service.watch(TEST_OZON_URL),second=service.watch('https://www.ozon.ru/product/456/');
  const unwatched=service.watch('https://www.ozon.ru/product/789/');
  await service.start();await service.running;
  const check=service.status().checks[0];
  assert.deepEqual(calls,['/my/favorites?sorting=last_added']);
  assert.equal(check.status,'success');assert.equal(check.completed,2);assert.equal(check.total,2);
  assert.equal(service.status().action_required,false);assert.equal(service.status().not_before,null);
  assert.equal(service.db.detail(first,0).product.listed_price_kopecks,95000);
  assert.equal(service.db.detail(first,0).product.original_price_kopecks,150000);
  assert.equal(service.db.detail(second,0).product.listed_price_kopecks,137300);
  assert.equal(service.db.detail(second,0).product.original_price_kopecks,null);
  assert.equal(service.db.detail(unwatched,0).points.length,0);
  assert.equal(service.db.listHistory('favorites',0).at(-1).listed.known_total,232300);
  assert.equal(service.db.listHistory('watching',0).length,0);
});

test('full refresh reads all favorites beyond five pages and accepts the final separator page', async t => {
  const root = temporary(t); await connectTestOzon(root);
  const calls = [];
  const client = new OzonClient(root, {browser:responseBrowser(async address => {
    const path = new URL(address).searchParams.get('url'); calls.push(path);
    const page = Number(new URL(path, 'https://www.ozon.ru').searchParams.get('page') || 1);
    const data = ozonPage();
    if (page === 8) {
      data.widgetStates = {'separator-1-default-8': JSON.stringify({height: 20})};
      delete data.nextPage;
    } else {
      data.widgetStates['tileGridDesktop-8-default-1'] = JSON.stringify({items:
        Array.from({length: 6}, (_, index) => favoriteTile(String(1000 + (page - 1) * 6 + index)))});
      data.nextPage = `/my/favorites?sorting=last_added&page=${page + 1}`;
    }
    return jsonResponse(data);
  })});
  const service = new OzonService(root, {client}); cleanup(t, () => service.close());
  await service.start(); await service.running;
  assert.equal(calls.length, 8);
  assert.ok(calls.every(path => path.startsWith('/my/favorites?')));
  assert.equal(service.status().checks[0].status, 'success');
  assert.equal(service.status().checks[0].completed, 42);
  assert.equal(service.db.dashboard('favorites').items.length, 42);
  assert.equal(service.db.dashboard('favorites').items.at(-1).listed_price_kopecks, 95000);
});

test('wrong account and incomplete lists cannot overwrite existing membership or save a new price', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let mode = 'wrong';
  const service = new OzonService(root,{pause:async () => {},client:new OzonClient(root,{browser:responseBrowser(async () => {
    const page = ozonPage({account:mode === 'wrong' ? 999 : 123});
    if (mode === 'partial') delete page.nextPage;
    return jsonResponse(page);
  })})});
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

test('schedule is opt-in, defaults to thirty minutes and never overlaps a manual check', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let now = Date.now(), calls = 0;
  const service = new OzonService(root,{current:() => now,client:new OzonClient(root,{browser:responseBrowser(async () => {calls++; return jsonResponse(ozonPage());})})});
  cleanup(t,() => service.close());
  await service.startScheduler(); await service.tick(); assert.equal(calls,0);
  service.settings({schedule_enabled:true});
  await service.tick(); assert.equal(calls,0);
  now += 30*60000+1;
  await service.tick(); await service.running;
  assert.equal(calls,1); // Empty but complete favorites; no cart or product requests.
  assert.equal(service.status().checks[0].trigger,'schedule');
  service.settings({schedule_enabled:false}); now += 86400000; await service.tick(); assert.equal(calls,1);
});

test('an interrupted persisted check is recoverable on restart and a foreign database is rejected without writes', async t => {
  const root = temporary(t); await connectTestOzon(root);
  let service = new OzonService(root);
  service.db.begin('manual',new Date().toISOString()); await service.close();
  service = new OzonService(root); cleanup(t,() => service.close());
  await service.startScheduler();
  assert.equal(service.status().action_required,false);
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

test('a guest response requests owner login only after the collection browser and lock are closed',async t => {
  const root=temporary(t);await connectTestOzon(root);let notifications=0,mode='guest';
  const service=new OzonService(root,{client:new OzonClient(root,{browser:responseBrowser(async () => {
    const data=ozonPage({account:mode==='guest' ? 0 : 999});
    data.userInfo.user.isLoggedIn=mode!=='guest';return jsonResponse(data);
  })})});
  cleanup(t,() => service.close());
  service.login.require=async () => {notifications++;const release=await acquireInstance(join(root,'.data/ozon/collector.lock'));await release();};
  await service.start();await service.running;
  assert.equal(notifications,1);assert.equal(service.status().action_required,true);
  assert.equal(service.db.dashboard('favorites').items.length,0);
  mode='other';service.db.updateState({action_required:0});await service.start();await service.running;
  assert.equal(notifications,1);
});
