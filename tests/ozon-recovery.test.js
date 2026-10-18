import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {OzonClient} from '../src/providers/ozon/client.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {createBrowserReader,browserCookieParams} from '../src/providers/ozon/browser-refresh.js';
import {browserCollection} from '../src/providers/ozon/recovery.js';
import {acquireInstance,AlreadyRunning} from '../src/instance.js';
import {temporary,cleanup} from './helpers.js';
import {connectTestOzon,ozonPage,jsonResponse,TEST_OZON_URL} from './ozon-fixture.js';

const requestFor = page => ({method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url='+encodeURIComponent(page),headers:{}});
const exported = request => ({version:2,request_url:request.url,user_agent:'Synthetic test browser',http_status:200,retry_after_ms:0,outcome:'json_received',
  data:ozonPage({sku:request.external_id || '123'})});
const fakeBrowser = read => ({read,close:async () => {}});

test('403 switches the whole queue to one browser under the collector lock and saves browser prices without an HTTP retry',async t => {
  const root = temporary(t);await connectTestOzon(root);let http = 0,browsers = 0,closed = 0;
  const path = join(root,'.secrets/ozon/session.json'),before = readFileSync(path),reads = [];
  const client = new OzonClient(root,{fetchImpl:async () => {http++;return new Response('',{status:403});},browser:async ({cookies}) => {
    assert.equal(cookies.length,1);assert.equal(cookies[0].value,'synthetic-session');
    browsers++;await assert.rejects(acquireInstance(join(root,'.data/ozon/collector.lock')),AlreadyRunning);
    return {read:async request => {assert.deepEqual(request.headers,{});reads.push(request.operation);return exported(request);},close:async () => {closed++;}};
  }});
  const service = new OzonService(root,{client,pause:async () => {}});cleanup(t,() => service.close());
  service.watch(TEST_OZON_URL);service.watch('https://www.ozon.ru/product/456/');
  await service.start();await service.running;
  assert.equal(http,1);assert.equal(browsers,1);assert.equal(closed,1);
  assert.deepEqual(reads,['favorites','cart','product','banks','product','banks']);
  assert.equal(service.status().action_required,false);assert.equal(service.status().schedule_enabled,false);assert.equal(service.status().not_before,null);
  for (const sku of ['123','456']) {
    const detail = service.db.detail('ozon:item:'+sku,0);
    assert.equal(detail.points.length,1);assert.equal(detail.points[0].source,'browser');assert.equal(detail.product.ozon_card_kopecks,90000);
  }
  assert.deepEqual(readFileSync(path),before);
});

test('a browser 403 stops the queue and cannot open another browser or fall back to HTTP',async t => {
  const root = temporary(t);await connectTestOzon(root);let http = 0,browsers = 0,reads = 0,closed = 0;
  const client = new OzonClient(root,{fetchImpl:async url => {
    http++;const page = new URL(url).searchParams.get('url');
    return page.startsWith('/my/favorites') || page === '/cart' ? jsonResponse(ozonPage()) : new Response('',{status:403});
  },browser:async () => {
    browsers++;return {read:async request => {
      reads++;assert.equal(request.external_id,'123');
      return reads === 2 ? {...exported(request),data:null,http_status:403,outcome:'access_limited'} : exported(request);
    },close:async () => {closed++;}};
  }});
  const service = new OzonService(root,{client,pause:async () => {}});cleanup(t,() => service.close());
  service.watch(TEST_OZON_URL);service.watch('https://www.ozon.ru/product/456/');
  await service.start();await service.running;
  assert.equal(http,3);assert.equal(browsers,1);assert.equal(reads,2);assert.equal(closed,1);
  assert.equal(service.status().action_required,true);assert.equal(service.status().not_before,null);
  assert.equal(service.db.detail('ozon:item:123',0).points[0].source,'browser');
  assert.equal(service.db.detail('ozon:item:456',0).points.length,0);
});

test('a different account, delivery, SKU, user agent or request identity cannot save browser prices',async t => {
  for (const change of [value => {value.data = ozonPage({account:999});},value => {value.data.location.current.uid='other';},
    value => {value.data = ozonPage({sku:'456'});},value => {value.user_agent='different';},value => {value.request_url='https://other.test/';},value => {value.version=1;}]) {
    const root = temporary(t);await connectTestOzon(root);let http=0;
    const client = new OzonClient(root,{fetchImpl:async () => {http++;return new Response('',{status:403});},
      browser:async () => fakeBrowser(async request => {const value=exported(request);change(value);return value;})});
    const service = new OzonService(root,{client});cleanup(t,() => service.close());const id=service.watch(TEST_OZON_URL);
    await service.start({id});await service.running;
    assert.equal(http,1);assert.equal(service.db.detail(id,0).product.regular_kopecks,null);assert.equal(service.status().action_required,true);
  }
});

test('429, 401, network errors and explicit Retry-After do not start a browser; cancellation closes it',async t => {
  for (const status of [429,401,503,403,0]) {
    const root=temporary(t);await connectTestOzon(root);let browsers=0;
    const client=new OzonClient(root,{fetchImpl:async () => {
      if (!status) throw Error('network');return new Response('',{status,headers:{'Retry-After':'120'}});
    },browser:async () => {browsers++;throw Error('Must not run');}});
    await client.open();await assert.rejects(client.product('123'));assert.equal(browsers,0);await client.close();
  }
  const root=temporary(t);await connectTestOzon(root);const controller=new AbortController();let closed=0;
  const client=new OzonClient(root,{fetchImpl:async () => new Response('',{status:403}),browser:async () => ({
    read:async request => {controller.abort();return exported(request);},close:async () => {closed++;},
  })});
  await client.open(controller.signal);await assert.rejects(client.product('123'),error => error.code==='interrupted');await client.close();assert.equal(closed,1);
});

test('403 on bank conditions verifies the browser product first and then reads banks without another HTTP request',async t => {
  const root=temporary(t);await connectTestOzon(root);const reads=[];let http=0;
  const client=new OzonClient(root,{fetchImpl:async () => ++http===1 ? jsonResponse(ozonPage()) : new Response('',{status:403}),
    browser:async () => fakeBrowser(async request => {reads.push(request.operation);return exported(request);})});
  await client.open();assert.equal((await client.product('123')).prices.ozon_card_kopecks,90000);await client.close();
  assert.equal(http,2);assert.deepEqual(reads,['product','banks']);
});

async function readerHarness(fetchImpl) {
  const calls=[];
  const call=async (method,params) => {
    calls.push([method,params]);
    if (method==='Browser.getVersion') return {userAgent:'Synthetic test browser'};
    if (method==='Target.createTarget') return {targetId:'synthetic'};
    if (method==='Target.attachToTarget') return {sessionId:'synthetic'};
    if (method==='Runtime.evaluate') return {result:{value:params.awaitPromise
      ? await runInNewContext(params.expression,{fetch:fetchImpl,AbortSignal,TextDecoder,Uint8Array,Date})
      : {origin:'https://www.ozon.ru',path:'/product/canonical-item-123/',ready:'complete'}}};
    return {};
  };
  return {reader:await createBrowserReader(call,requestFor('/product/123/'),{pause:async () => {}}),calls};
}

test('the browser navigates once, reads only validated GET URLs, bounds responses and confines banks to the latest SKU',async () => {
  const {reader,calls}=await readerHarness(async (url,options) => {
    assert.equal(options.credentials,'include');assert.equal(options.redirect,'error');return jsonResponse(ozonPage());
  });
  const product=requestFor('/product/123/'),banks=requestFor('/modal/pdpListOfBanks?product_id=123');
  assert.equal((await reader.read(product)).outcome,'json_received');assert.equal((await reader.read(banks)).http_status,200);
  await assert.rejects(reader.read(requestFor('/modal/pdpListOfBanks?product_id=456')));
  await assert.rejects(reader.read({...product,method:'POST'}));await assert.rejects(reader.read({...product,url:'https://evil.test/'}));
  assert.equal(calls.filter(([method]) => method==='Page.navigate').length,1);
  assert.equal(calls.filter(([method,params]) => method==='Runtime.evaluate' && params.awaitPromise).length,2);
  assert.equal(calls.some(([method]) => method==='Storage.getCookies'),false);
});

test('browser responses preserve rate limits and reject HTML, oversized bodies and network failures without exposing raw data',async () => {
  for (const [fetchImpl,outcome] of [
    [async () => new Response('private',{status:429,headers:{'Retry-After':'7200'}}),'rate_limited'],
    [async () => new Response('private',{status:401}),'login_required'],
    [async () => new Response('private',{status:403}),'access_limited'],
    [async () => new Response('private',{headers:{'Content-Type':'text/html'}}),'unexpected_content'],
    [async () => new Response('x'.repeat(8388609),{headers:{'Content-Type':'application/json'}}),'response_too_large'],
    [async () => {throw Error('private-network');},'network_error'],
  ]) {
    const {reader}=await readerHarness(fetchImpl);const result=await reader.read(requestFor('/product/123/'));
    assert.equal(result.outcome,outcome);assert.doesNotMatch(JSON.stringify(result),/private/);
    if (outcome==='rate_limited') assert.equal(result.retry_after_ms,7200000);
  }
});

test('only scoped unexpired session cookies can seed Chrome, preserving secure host-only cookies',() => {
  const cookie={name:'__Host-auth',value:'synthetic-session',domain:'www.ozon.ru',hostOnly:true,path:'/',secure:true,httpOnly:true,sameSite:'lax'};
  const [param]=browserCookieParams([cookie]);assert.equal(param.url,'https://www.ozon.ru/');assert.equal(param.domain,undefined);assert.equal(param.sameSite,'Lax');
  assert.deepEqual(browserCookieParams([{...cookie,expires:1}]),[]);
  for (const changed of [{domain:'evil.test'},{path:'/my/profile'},{secure:false},{hostOnly:false},{value:'bad\nvalue'},{sameSite:'invalid'}]) {
    assert.throws(() => browserCookieParams([{...cookie,...changed}]));
  }
});

test('one socket supports sequential split replies and cancellation disconnects the worker',{skip:process.platform==='win32'},async t => {
  const root=temporary(t),path=join(root,'browser.sock'),sockets=new Set();let mode='reply',disconnected;
  const server=createServer(socket => {
    const stalled=mode==='stall';sockets.add(socket);socket.on('close',() => {sockets.delete(socket);if(stalled)disconnected?.();});
    socket.on('data',chunk => {
      const input=JSON.parse(chunk.toString('utf8'));assert.equal(input.version,2);
      if (mode==='reply') {const response=JSON.stringify({version:2,id:input.id,browser_closed:input.close===true})+'\n';socket.write(response.slice(0,5));setImmediate(() => socket.write(response.slice(5)));}
    });
  });
  server.listen(path);await once(server,'listening');t.after(async () => {for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const browser=browserCollection({},{path});
  assert.equal((await browser.read(requestFor('/product/123/'))).id,1);assert.equal((await browser.read(requestFor('/cart'))).id,2);await browser.close();
  mode='stall';const controller=new AbortController(),closed=new Promise(resolve=>{disconnected=resolve;});
  const stalled=browserCollection({signal:controller.signal},{path}),pending=stalled.read(requestFor('/product/123/'));
  await once(server,'connection');controller.abort();await assert.rejects(pending,/Browser unavailable/);await closed;
});
