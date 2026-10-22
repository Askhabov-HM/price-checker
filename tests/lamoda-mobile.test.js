import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {parseWishlistState} from '../src/providers/lamoda/parser.js';
import {Tracker} from '../src/service.js';
import {makeServer,listen} from '../src/web.js';
import {Authentication,createCredentials} from '../src/auth.js';
import {TelegramBot} from '../src/telegram.js';
import {androidLaunchPage,androidLaunchScript} from '../src/providers/lamoda/mobile-launch.js';
import {temporary,cleanup} from './helpers.js';

const product = sku => ({sku,name:'Пример',brand:{name:'Бренд'},seo_tail:'example',price_iso_code:'RUB',price_amount:'100',old_price_amount:'120',is_available:true,is_sellable:true});
const state = (page = 1,options = {}) => {
  const favorites = options.favorites || ['SYNTHETIC001','SYNTHETIC002'];
  return {user:{customer:{id:options.account || 42,is_active:true},wishlist:favorites.map(product_sku => ({product_sku}))},
    payload:{products:[product(favorites[page-1])],pagination:{page,limit:1,offset:page-1,found:favorites.length,pages:favorites.length}}};
};
function service(t,options = {}) {
  const root = temporary(t),lamoda = new LamodaService(root,{logger:() => {},...options});
  cleanup(t,() => lamoda.close());return {root,lamoda,mobile:lamoda.mobile};
}
function pair(mobile) {return mobile.pair(mobile.pairing().code,'Synthetic Android').token;}

test('Android pairing expires, is single-use, rotates the scoped token, and stores only token hashes',t => {
  let clock = Date.now();const {mobile,lamoda} = service(t,{current:() => clock});
  const first = mobile.pairing();clock+=11*60000;
  assert.throws(() => mobile.pair(first.code,'phone'));
  const code = mobile.pairing().code,token = mobile.pair(code,'phone').token;
  assert.throws(() => mobile.pair(code,'phone'));
  assert.equal(mobile.authenticate('Bearer '+token),true);
  assert.equal(mobile.authenticate('Bearer invalid'),false);
  assert.doesNotMatch(JSON.stringify(lamoda.db.db.prepare('SELECT * FROM mobile_device').get()),new RegExp(token));
  assert.equal(JSON.stringify(lamoda.status()).includes(token),false);
  const replacement = pair(mobile);assert.equal(mobile.authenticate('Bearer '+token),false);
  assert.equal(mobile.authenticate('Bearer '+replacement),true);
  mobile.revoke();assert.equal(mobile.authenticate('Bearer '+replacement),false);
});

test('Only the owner in a private Telegram chat can create a one-use Android connection button',async t => {
  const {root,lamoda,mobile} = service(t),tracker = new Tracker(root),sent = [];
  const bot = new TelegramBot(tracker,{lamoda,ownerId:123,publicOrigin:'https://prices.example',logger:() => {},api:{async call(method,data){sent.push(data);return {message_id:1};},close(){}}});
  cleanup(t,async () => {await bot.close();await tracker.close();});
  const command = (id,from = 123,type = 'private') => ({update_id:id,message:{from:{id:from},chat:{id:123,type},text:'/lamoda_android'}});
  await bot.handleUpdate(command(1,456));await bot.handleUpdate(command(2,123,'group'));
  assert.equal(sent.length,0);assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM mobile_pairing').get().n,0);
  await bot.handleUpdate(command(3));
  assert.equal(sent.length,1);assert.equal(sent[0].chat_id,123);
  const link = new URL(sent[0].reply_markup.inline_keyboard[0][0].url);
  assert.equal(link.origin,'https://prices.example');assert.equal(link.pathname,'/lamoda/android/open');assert.equal(link.search,'');
  assert.match(link.hash,/^#connect=[a-f0-9]{32}$/);
  const invitation = link.hash.slice('#connect='.length);
  assert.equal(sent[0].text.includes(invitation),false);
  assert.ok(mobile.pair(invitation,'phone').token);
  assert.throws(() => mobile.pair(invitation,'phone'));
});

test('Android launcher forwards only a valid fragment to the fixed app and never auto-navigates',() => {
  const invitation = '0123456789abcdef0123456789abcdef';
  const render = hash => {
    const elements = {open:{href:'original',removeAttribute(name){delete this[name];}},help:{}};
    runInNewContext(androidLaunchScript,{location:{hash},document:{getElementById:id => elements[id]}});
    return elements;
  };
  assert.match(androidLaunchPage,/src="\/lamoda\/android\/launch.js"/);
  assert.equal(render('').open.href,'original');
  assert.equal(render('#connect='+invitation).open.href,'intent://collect?connect='+invitation+'#Intent;scheme=pricechecker-lamoda;package=ru.pricechecker.lamoda;end');
  for (const fragment of ['#connect=invalid','#connect='+invitation+'&server=https://other.example','#connect='+invitation+'#Intent;package=evil;end']) {
    assert.equal(render(fragment).open.href,undefined);
  }
});

test('Android stages every page before changing history, accepts identical retries and records the source',async t => {
  const {lamoda,mobile} = service(t);pair(mobile);await lamoda.start({trigger:'android'});
  const job = mobile.next(),first = state(),second = state(2);
  second.user.wishlist[1].adjacent_skus = ['SYNTHETIC002','SYNTHETIC009'];
  second.payload.products[0] = {...product('SYNTHETIC009'),is_hybrid:true,hybrid_products:['SYNTHETIC002','SYNTHETIC009']};
  const a = await mobile.accept(job.id,1,first.user,first.payload);
  assert.equal(a.complete,false);assert.equal(lamoda.db.dashboard().items.length,0);
  assert.deepEqual(await mobile.accept(job.id,1,first.user,first.payload),a);
  assert.equal((await mobile.accept(job.id,2,second.user,second.payload)).complete,true);
  await lamoda.running;
  assert.equal(lamoda.db.dashboard().items.length,2);assert.equal(lamoda.db.matches('42'),true);
  const sellerItem = lamoda.db.dashboard().items.find(item => item.sku === 'SYNTHETIC002');
  assert.equal(sellerItem.price,10000);assert.match(sellerItem.url,/\/synthetic009\//);
  assert.equal(lamoda.db.db.prepare('SELECT source FROM observations LIMIT 1').get().source,'android');
  assert.equal((await mobile.accept(job.id,2,second.user,second.payload)).complete,true);
  assert.equal(lamoda.db.checks()[0].status,'success');
});

test('Android refuses other accounts and changed membership, and a failed partial upload preserves saved prices',async t => {
  const {lamoda,mobile} = service(t);pair(mobile);lamoda.db.bindAccount('42');
  const seed = state(1,{favorites:['SYNTHETIC001']}),stamp = new Date().toISOString();
  lamoda.db.record(lamoda.db.begin('seed',stamp),parseWishlistState(seed.user,seed.payload).items,stamp);
  await lamoda.start();const job = mobile.next(),first = state();
  first.payload.products[0].price_amount='90';
  await mobile.accept(job.id,1,first.user,first.payload);
  const other = state(2,{account:99});await assert.rejects(mobile.accept(job.id,2,other.user,other.payload),e => e.code==='account_mismatch');
  const changed = state(2,{favorites:['SYNTHETIC001','SYNTHETIC003']});
  await assert.rejects(mobile.accept(job.id,2,changed.user,changed.payload),e => e.code==='incomplete_data');
  mobile.fail(job.id,'incomplete_data');await lamoda.running;
  assert.equal(lamoda.db.dashboard().items.length,1);assert.equal(lamoda.db.dashboard().items[0].price,10000);
  assert.equal(lamoda.db.dashboard().items[0].price_at,stamp);assert.equal(lamoda.db.checks()[0].status,'error');
});

test('Android obeys source Retry-After and expired jobs leave the schedule enabled',async t => {
  let clock = Date.now();const {lamoda,mobile} = service(t,{current:() => clock});pair(mobile);lamoda.db.bindAccount('42');lamoda.settings({schedule_enabled:true});
  await lamoda.start();mobile.fail(mobile.next().id,'rate_limited',3600000,429);await lamoda.running;
  assert.equal(Date.parse(lamoda.status().not_before),clock+3600000);assert.equal(lamoda.status().schedule_enabled,true);
  clock+=3600001;await lamoda.start();const job = mobile.next();clock+=46*60000;
  await assert.rejects(mobile.accept(job.id,1,state().user,state().payload));await lamoda.running;
  assert.equal(lamoda.db.checks()[0].status,'interrupted');assert.equal(lamoda.status().schedule_enabled,true);
});

test('Android HTTP API scopes bearer tokens, requires owner CSRF for pairing, and sends the Telegram launch link',async t => {
  const {root,lamoda,mobile} = service(t),tracker = new Tracker(root);
  const auth = new Authentication(await createCredentials('owner','synthetic-test-password'));
  const server = makeServer(tracker,{lamoda,auth}),port = await listen(server,0),base = 'http://127.0.0.1:'+port;
  const sent=[],bot = new TelegramBot(tracker,{lamoda,ownerId:123,publicOrigin:'https://prices.example',logger:() => {},api:{async call(method,data){sent.push(data);return {message_id:1};},close(){}}});
  cleanup(t,async () => {await bot.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));await tracker.close();});
  const post = (path,body = {},headers = {}) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/providers/lamoda/mobile/pairing')).status,401);
  assert.equal((await post('/api/providers/lamoda/mobile/connect')).status,401);
  const anon = await (await fetch(base+'/api/auth')).json();
  const login = await post('/api/login',{login:'owner',password:'synthetic-test-password'},{'X-CSRF-Token':anon.csrf_token});
  const session = await login.json(),cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/providers/lamoda/mobile/pairing',{}, {Cookie:cookie})).status,403);
  assert.equal((await post('/api/providers/lamoda/mobile/connect',{}, {Cookie:cookie})).status,403);
  const connection = await (await post('/api/providers/lamoda/mobile/connect',{}, {Cookie:cookie,'X-CSRF-Token':session.csrf_token})).json();
  assert.match(connection.url,/^\/lamoda\/android\/open#connect=[a-f0-9]{32}$/);assert.equal(connection.code,undefined);
  const pairing = await (await post('/api/providers/lamoda/mobile/pairing',{}, {Cookie:cookie,'X-CSRF-Token':session.csrf_token})).json();
  const paired = await (await post('/api/lamoda-mobile/pair',{code:pairing.code,name:'Test Android'})).json();
  const device = {Authorization:'Bearer '+paired.token};
  assert.equal((await fetch(base+'/api/providers/lamoda/status',{headers:device})).status,401);
  assert.equal((await fetch(base+'/api/lamoda-mobile/next')).status,401);
  assert.equal((await fetch(base+'/api/lamoda-mobile/next',{headers:{...device,Origin:'https://other.example'}})).status,403);
  const started = await (await post('/api/lamoda-mobile/start',{},device)).json();assert.ok(started.job);
  await bot.deliverLamoda();assert.equal(sent.length,1);assert.match(sent[0].text,/телефоне/);
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url,'https://prices.example/lamoda/android/open');
  for (const page of [1,2]) {
    const input = state(page),result = await post('/api/lamoda-mobile/page',{job_id:started.job.id,page,...input},device);
    assert.equal(result.status,200);
  }
  await lamoda.running;assert.equal(lamoda.db.dashboard().items.length,2);
  assert.equal(tracker.db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'mobile_%'").n,0);
  assert.equal((await fetch(base+'/lamoda/android/open')).status,200);
  const script = await fetch(base+'/lamoda/android/launch.js');
  assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);assert.equal(await script.text(),androidLaunchScript);
});

test('Android collector uses only fixed same-origin wishlist GETs and strips profile information',async () => {
  const source = readFileSync(new URL('../apps/lamoda-android/app/src/main/assets/collector.js',import.meta.url),'utf8');
  const input = state();input.user.customer.email='synthetic-private@example.invalid';input.user.delivery_address='synthetic-private';
  input.user.wishlist[0].adjacent_skus = ['SYNTHETIC001','SYNTHETIC009'];
  input.payload.products[0] = {...product('SYNTHETIC009'),is_hybrid:true,hybrid_products:['SYNTHETIC001','SYNTHETIC009']};
  const script = 'var __NUXT__ = {\n        user: '+JSON.stringify(input.user)+',\n        payload: '+JSON.stringify(input.payload)+',\n};';
  const calls=[],context = {location:{origin:'https://www.lamoda.ru'},AbortSignal,TextDecoder,TextEncoder,
    DOMParser:class {parseFromString(){return {scripts:[{textContent:script}]};}},
    fetch:async (url,options) => {calls.push({url,options});return new Response('<html>synthetic</html>',{headers:{'content-type':'text/html'}});}};
  runInNewContext(source,context);
  const result = JSON.parse(JSON.stringify(await context.__priceCheckerReadPage(1)));
  assert.equal(calls[0].url,'/wishlist/?page=1');assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(calls.length,1);assert.equal(result.user.customer.id,42);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
  assert.deepEqual(result.user.wishlist[0].adjacent_skus,['SYNTHETIC001','SYNTHETIC009']);
  assert.equal(parseWishlistState(result.user,result.payload).items[0].sku,'SYNTHETIC001');
  context.location.origin='https://other.example';assert.equal((await context.__priceCheckerReadPage(2)).error,'invalid_data');assert.equal(calls.length,1);
  context.location.origin='https://www.lamoda.ru';context.fetch=async () => new Response('',{status:429,headers:{'Retry-After':'120'}});
  const limited=await context.__priceCheckerReadPage(1);assert.equal(limited.retry_after_ms,120000);assert.equal(limited.error,'rate_limited');
});
