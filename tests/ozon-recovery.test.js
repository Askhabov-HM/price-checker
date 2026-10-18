import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OzonClient} from '../src/providers/ozon/client.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {refreshBrowser} from '../src/providers/ozon/browser-refresh.js';
import {acquireInstance, AlreadyRunning} from '../src/instance.js';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {browserRecovery} from '../src/providers/ozon/recovery.js';
import {temporary, cleanup} from './helpers.js';
import {connectTestOzon, ozonPage, jsonResponse, TEST_OZON_URL} from './ozon-fixture.js';

const exported = request => ({version:1,request_url:request.url,browser_closed:true,user_agent:'Synthetic test browser',data:ozonPage(),
  cookies:[{name:'session',value:'fresh-synthetic',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,session:true}]});

test('403 refreshes once under the existing collection lock, persists cookies and records only the HTTP success', async t => {
  const root = temporary(t); await connectTestOzon(root); let calls = 0, recoveries = 0;
  const client = new OzonClient(root,{recover:async ({request}) => {
    recoveries++; assert.deepEqual(request.headers,{});
    // Another collector cannot start while the browser is running.
    await assert.rejects(acquireInstance(join(root,'.data/ozon/collector.lock')),AlreadyRunning);
    return exported(request);
  },fetchImpl:async (url,options) => {
    calls++;
    if (calls === 1) return new Response('',{status:403});
    assert.match(options.headers.cookie,/fresh-synthetic/);
    return jsonResponse(ozonPage());
  }});
  const service = new OzonService(root,{client}); cleanup(t,() => service.close());
  const id = service.watch(TEST_OZON_URL);
  await service.start({id}); await service.running;
  assert.equal(calls,3); // Failed card, one control card, bank conditions.
  assert.equal(recoveries,1); assert.equal(service.status().action_required,false);
  assert.equal(service.status().schedule_enabled,false);
  const detail = service.db.detail(id,0);
  assert.equal(detail.points.length,1); assert.equal(detail.points[0].source,'http');
  assert.equal(detail.product.ozon_card_kopecks,90000);
  const restarted = new OzonClient(root,{recover:null,fetchImpl:async (url,options) => {
    assert.match(options.headers.cookie,/fresh-synthetic/);return jsonResponse(ozonPage());
  }});
  await restarted.open(); await restarted.product('123');
});

test('second 403 stops the queue and cannot launch a second browser, including a later bank request', async t => {
  for (const failAt of [2,3]) {
    const root = temporary(t); await connectTestOzon(root); let calls = 0, recoveries = 0;
    const client = new OzonClient(root,{recover:async ({request}) => {recoveries++;return exported(request);},
      fetchImpl:async url => {
        const page = new URL(url).searchParams.get('url');
        if (page.startsWith('/my/favorites') || page === '/cart') return jsonResponse(ozonPage());
        assert.doesNotMatch(page,/456/); // The second queued product must never be requested.
        calls++;return calls === 1 || calls >= failAt ? new Response('',{status:403}) : jsonResponse(ozonPage());
      }});
    const service = new OzonService(root,{client}); cleanup(t,() => service.close());
    service.watch(TEST_OZON_URL); service.watch('https://www.ozon.ru/product/456/');
    await service.start(); await service.running;
    assert.equal(calls,failAt); assert.equal(recoveries,1);assert.equal(service.status().action_required,true);
    assert.equal(service.db.detail('ozon:item:123',0).points.length,1);
    await assert.rejects(service.start(),/приостановлены/);
  }
});

test('wrong account, address, SKU, browser UA or unclosed browser cannot replace saved cookies', async t => {
  for (const change of [value => {value.data = ozonPage({account:999});}, value => {value.data.location.current.uid = 'other';},
    value => {value.data = ozonPage({sku:'456'});}, value => {value.user_agent = 'different';}, value => {value.browser_closed = false;},
    value => {value.cookies[0].partitionKeyOpaque = true;}]) {
    const root = temporary(t); await connectTestOzon(root);
    const path = join(root,'.secrets/ozon/session.json'), before = readFileSync(path);
    let calls = 0;
    const client = new OzonClient(root,{fetchImpl:async () => {calls++;return new Response('',{status:403});},
      recover:async ({request}) => {const value = exported(request);change(value);return value;}});
    await client.open(); await assert.rejects(client.product('123'));
    assert.equal(calls,1);assert.deepEqual(readFileSync(path),before);
  }
});

test('429, 401, network failure, 403 Retry-After and cancellation do not trigger browser recovery', async t => {
  for (const status of [429,401,503,403,0]) {
    const root = temporary(t); await connectTestOzon(root);let recoveries = 0;
    const client = new OzonClient(root,{fetchImpl:async () => {
      if (!status) throw Error('network');
      return new Response('',{status,headers:{'Retry-After':'120'}});
    },recover:async () => {recoveries++;throw Error('should not run');}});
    await client.open();await assert.rejects(client.product('123'));assert.equal(recoveries,0);
  }
  const root = temporary(t);await connectTestOzon(root);const controller = new AbortController();
  const path = join(root,'.secrets/ozon/session.json'), before = readFileSync(path);
  const client = new OzonClient(root,{fetchImpl:async () => new Response('',{status:403}),recover:async ({request}) => {
    controller.abort();return exported(request);
  }});
  await client.open(controller.signal);await assert.rejects(client.product('123'),error => error.code === 'interrupted');
  assert.deepEqual(readFileSync(path),before);
});

test('browser refresh permits one navigation and one fixed API fetch; it cannot mutate the account', async () => {
  const calls = [], request = {method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2F123%2F'};
  const call = async (method,params) => {
    calls.push([method,params]);
    if (method === 'Browser.getVersion') return {userAgent:'Synthetic test browser'};
    if (method === 'Target.createTarget') return {targetId:'test'};
    if (method === 'Target.attachToTarget') return {sessionId:'test'};
    if (method === 'Runtime.evaluate') return {result:{value:params.awaitPromise ? ozonPage() : {origin:'https://www.ozon.ru',path:'/product/123/',ready:'complete'}}};
    if (method === 'Storage.getCookies') return {cookies:exported(request).cookies};
    return {};
  };
  const result = await refreshBrowser(call,request,{pause:async () => {}});
  assert.equal(result.request_url,request.url);
  assert.equal(calls.filter(([method]) => method === 'Page.navigate').length,1);
  const reads = calls.filter(([method,params]) => method === 'Runtime.evaluate' && params.awaitPromise);
  assert.equal(reads.length,1);assert.match(reads[0][1].expression,/redirect:"error"/);
  await assert.rejects(refreshBrowser(call,{...request,method:'POST'}));
  await assert.rejects(refreshBrowser(call,{...request,url:'https://evil.test/'}));
});

test('socket refresh handles split replies and closes a stalled worker connection on cancellation', {skip:process.platform === 'win32'}, async t => {
  const root = temporary(t), path = join(root,'recovery.sock'), sockets = new Set();
  let mode = 'reply', disconnected;
  const server = createServer(socket => {
    const stalled = mode === 'stall';
    sockets.add(socket);socket.on('close',() => {sockets.delete(socket);if (stalled) disconnected?.();});
    socket.on('data',chunk => {
      const input = JSON.parse(chunk.toString('utf8'));assert.equal(input.version,1);
      if (mode === 'reply') {socket.write('{"version":');setImmediate(() => socket.end('1}\n'));}
    });
  });
  server.listen(path);await once(server,'listening');
  t.after(async () => {for(const socket of sockets) socket.destroy();await new Promise(resolve => server.close(resolve));});
  assert.deepEqual(await browserRecovery({request:{}},{path}),{version:1});
  mode = 'stall';const controller = new AbortController();
  const closed = new Promise(resolve => {disconnected = resolve;});
  const pending = browserRecovery({request:{},signal:controller.signal},{path});
  await once(server,'connection');controller.abort();
  await assert.rejects(pending,/Recovery unavailable/);await closed;
});

test('control HTTP redirect stops without following it or starting another browser', async t => {
  const root = temporary(t);await connectTestOzon(root);let calls = 0, recoveries = 0;
  const client = new OzonClient(root,{recover:async ({request}) => {recoveries++;return exported(request);},fetchImpl:async () => {
    calls++;
    return calls === 1 ? new Response('',{status:403}) : new Response('',{status:307,headers:{location:'/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2F123%2F&__rr=1'}});
  }});
  await client.open();await assert.rejects(client.product('123'));assert.equal(calls,2);assert.equal(recoveries,1);
});

test('a first 403 on bank conditions refreshes the same SKU card and retries only the failed bank read', async t => {
  const root = temporary(t);await connectTestOzon(root);const pages = [];let recoveries = 0;
  const client = new OzonClient(root,{recover:async ({request}) => {
    recoveries++;assert.equal(request.operation,'product');assert.equal(request.external_id,'123');return exported(request);
  },fetchImpl:async url => {
    const page = new URL(url).searchParams.get('url');pages.push(page);
    return pages.length === 2 ? new Response('',{status:403}) : jsonResponse(ozonPage());
  }});
  await client.open();const product = await client.product('123');
  assert.equal(product.prices.ozon_card_kopecks,90000);
  assert.equal(recoveries,1);assert.equal(pages.length,3);assert.equal(pages[1],pages[2]);
  assert.equal(pages[0],'/product/123/');
});
