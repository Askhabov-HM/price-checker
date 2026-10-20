import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {connect} from 'node:net';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {PersistentBrowserPool,browserIdleMs} from '../src/providers/ozon/browser-pool.js';
import {createRecoveryServer} from '../src/providers/ozon/recovery-server.js';
import {createBrowserReader,browserCookieSeed} from '../src/providers/ozon/browser-refresh.js';
import {OzonClient} from '../src/providers/ozon/client.js';
import {OzonSession} from '../src/providers/ozon/session.js';
import {temporary} from './helpers.js';
import {connectTestOzon,ozonPage} from './ozon-fixture.js';

const request = {method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmy%2Ffavorites',headers:{}};
function fixture(t, {idleMs = 3600000} = {}) {
  let now = 0;
  const timers = new Set(),workers = [],events = [];
  const pool = new PersistentBrowserPool({
    idleMs,
    schedule(fn,ms) {const timer = {fn,at:now+ms};timers.add(timer);return timer;},
    cancel(timer) {timers.delete(timer);},
    launch({persistent}) {
      const id = workers.length+1;
      const worker = {persistent,closed:false,reads:0,
        isAlive:() => !worker.closed,
        async send(message) {
          assert.equal(worker.closed,false);
          if (message.release) {events.push('release:'+id);return {released:true};}
          if (message.warmup) {events.push('warmup:'+id);return {ready:true};}
          worker.reads++;events.push('read:'+id);return {worker:id};
        },
        async close() {worker.closed = true;events.push('close:'+id);},
      };
      workers.push(worker);events.push('launch:'+id);return worker;
    },
  });
  t.after(() => pool.close());
  return {pool,workers,events,async advance(ms) {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) {timers.delete(timer);timer.fn();}
    await turn();
  }};
}

test('Chrome stays open by default, zero disables idle expiry and finite timeouts remain supported',() => {
  assert.equal(browserIdleMs({}),0);
  assert.equal(browserIdleMs({OZON_BROWSER_IDLE_MINUTES:'0'}),0);
  assert.equal(browserIdleMs({OZON_BROWSER_IDLE_MINUTES:'70'}),4200000);
  assert.equal(browserIdleMs({OZON_BROWSER_IDLE_MINUTES:'120'}),7200000);
  for (const value of ['00','-1','1.5','1441','60x','']) assert.throws(() => browserIdleMs({OZON_BROWSER_IDLE_MINUTES:value}));
});

test('24/7 mode starts Chrome without Ozon reads and never closes or polls it during a day of inactivity',async t => {
  const {pool,workers,events,advance} = fixture(t,{idleMs:0});
  await pool.ensureWarm();assert.equal(workers.length,1);assert.equal(workers[0].reads,0);
  const initial = [...events];
  for (let hour = 0; hour < 24; hour++) {await advance(3600000);await pool.ensureWarm();}
  assert.deepEqual(events,initial);assert.equal(workers[0].closed,false);
  const collection = await pool.acquire();await collection.send({request});await collection.release();
  await advance(25*3600000);assert.equal(workers[0].closed,false);assert.equal(workers.length,1);
});

test('maintenance replaces a crashed idle browser without retrying a collection or interrupting login',async t => {
  const {pool,workers} = fixture(t,{idleMs:0});
  await pool.ensureWarm();workers[0].closed = true;await pool.ensureWarm();
  assert.equal(workers.length,2);assert.equal(workers[1].reads,0);
  const login = await pool.acquire({login:true});
  await pool.ensureWarm();assert.equal(workers.length,3);assert.equal(workers[2].closed,false);
  await login.release();assert.equal(workers[2].closed,true);
  await pool.ensureWarm();assert.equal(workers.length,4);assert.equal(workers[3].persistent,true);
});

test('failed warmup retires its worker and the next maintenance attempt can recover',async t => {
  const {pool,workers} = fixture(t,{idleMs:0});
  const launch = pool.launch;let fail = true;
  pool.launch = options => {
    const worker = launch(options),send = worker.send;
    worker.send = async message => fail && message.warmup ? {ready:false} : send(message);
    return worker;
  };
  await assert.rejects(pool.ensureWarm(),/Browser unavailable/);
  assert.equal(workers[0].closed,true);assert.equal(pool.available,false);
  fail = false;await pool.ensureWarm();assert.equal(workers.length,2);assert.equal(pool.available,true);
});

test('cold startup preserves refreshed profile cookies and seeds only missing or expired ones',() => {
  const cookie={name:'session',value:'old-http-synthetic',domain:'ozon.ru',hostOnly:false,path:'/',secure:true,httpOnly:true};
  const saved={name:'session',value:'fresh-profile-synthetic',domain:'.ozon.ru',path:'/',session:true};
  assert.deepEqual(browserCookieSeed([cookie],[saved]),[]);
  const missing=browserCookieSeed([cookie,{...cookie,name:'other'}],[saved]);
  assert.deepEqual(missing.map(value => value.name),['other']);
  assert.equal(browserCookieSeed([cookie],[{...saved,session:false,expires:1}]).length,1);
});

test('collections thirty minutes apart reuse Chrome and extend idle expiry to one hour after release',async t => {
  const {pool,workers,advance} = fixture(t);
  const first = await pool.acquire();assert.equal((await first.send({request})).worker,1);await first.release();
  await advance(30*60000);assert.equal(workers[0].closed,false);
  const second = await pool.acquire();assert.equal((await second.send({request})).worker,1);await second.release();
  assert.equal(workers.length,1);
  await advance(59*60000);assert.equal(workers[0].closed,false);
  await advance(60000);assert.equal(workers[0].closed,true);assert.equal(pool.worker,null);
  const third = await pool.acquire();assert.equal((await third.send({request})).worker,2);await third.release();
});

test('a queued collection cannot interleave requests and an aborted waiter never acquires Chrome',async t => {
  const {pool,workers} = fixture(t),first = await pool.acquire();
  let entered = false;
  const waiting = pool.acquire().then(lease => {entered = true;return lease;});
  const abort = new AbortController(),cancelled = pool.acquire({signal:abort.signal});
  abort.abort();await assert.rejects(cancelled,/Browser unavailable/);
  await turn();assert.equal(entered,false);
  await first.send({request});await first.release();
  const next = await waiting;await next.send({request});await next.release();
  assert.equal(workers.length,1);assert.equal(workers[0].reads,2);
});

test('disconnect waits for an in-flight read before handing the profile to the next collection',async t => {
  const {pool,workers,advance} = fixture(t),first = await pool.acquire();
  let finish;
  const send = workers[0].send;
  workers[0].send = message => message.release ? send(message) : new Promise(resolve => {finish = resolve;});
  const read = first.send({request});await turn();
  let entered = false;
  const waiting = pool.acquire().then(lease => {entered = true;return lease;});
  const released = first.release();await advance(2*3600000);
  assert.equal(entered,false);assert.equal(workers[0].closed,false);
  finish({worker:1});await read;await released;
  const next = await waiting;await next.release();assert.equal(workers.length,1);
});

test('interactive login retires the shared browser, owns the profile exclusively and closes after login',async t => {
  const {pool,workers,events} = fixture(t);
  const first = await pool.acquire();await first.send({request});await first.release();
  const login = await pool.acquire({login:true});await login.send({login:'start',request});
  assert.equal(workers[0].closed,true);assert.equal(workers[1].persistent,false);
  assert.ok(events.indexOf('close:1') < events.indexOf('launch:2'));
  let entered = false;
  const waiting = pool.acquire().then(lease => {entered = true;return lease;});
  await turn();assert.equal(entered,false);
  await login.release();assert.equal(workers[1].closed,true);
  const next = await waiting;assert.equal(workers[2].persistent,true);await next.release();
  assert.ok(events.indexOf('close:2') < events.indexOf('launch:3'));
});

test('a crashed worker is retired without retrying the failed read and the next collection launches a new one',async t => {
  const {pool,workers} = fixture(t),first = await pool.acquire();let reads = 0;
  workers[0].send = async () => {reads++;throw Error('closed');};
  await assert.rejects(first.send({request}),/closed/);
  await assert.rejects(first.send({request}),/Browser unavailable/);
  await first.release();assert.equal(reads,1);assert.equal(workers[0].closed,true);
  const next = await pool.acquire();assert.equal(workers.length,2);await next.release();
});

test('a worker lost while idle is not advertised as a warm browser and is replaced on demand',async t => {
  const {pool,workers} = fixture(t),first = await pool.acquire();
  await first.send({request});await first.release();assert.equal(pool.available,true);
  workers[0].closed = true;assert.equal(pool.available,false);
  const next = await pool.acquire();assert.equal((await next.send({request})).worker,2);
  await next.release();assert.equal(workers.length,2);
});

test('shutdown during launch waits for and closes the new worker instead of leaking the profile',async () => {
  let launched,closed = 0;
  const pool = new PersistentBrowserPool({launch:() => new Promise(resolve => {launched = resolve;})});
  const opening = pool.acquire(),rejected = assert.rejects(opening,/Browser unavailable/);
  await turn();const stopping = pool.close();
  launched({close:async () => {closed++;}});
  await stopping;await rejected;assert.equal(closed,1);
});

test('a reused page resets per-collection read limits and bank permissions without navigating again',async () => {
  let navigations = 0;
  const call = async (method,params) => {
    if (method === 'Browser.getVersion') return {userAgent:'Synthetic test browser'};
    if (method === 'Target.createTarget') return {targetId:'page'};
    if (method === 'Target.attachToTarget') return {sessionId:'session'};
    if (method === 'Page.navigate') navigations++;
    if (method === 'Runtime.evaluate') return {result:{value:params.awaitPromise
      ? {http_status:200,outcome:'json_received',data:ozonPage()}
      : {origin:'https://www.ozon.ru',path:'/my/favorites',ready:'complete'}}};
    return {};
  };
  const reader = await createBrowserReader(call,request,{pause:async () => {}});
  for (let i = 0; i < 220; i++) await reader.read(request);
  await assert.rejects(reader.read(request));reader.reset();await reader.read(request);
  await assert.rejects(reader.read({...request,url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmodal%2FpdpListOfBanks%3Fproduct_id%3D123'}));
  assert.equal(navigations,1);
});

test('only a matching browser account may update the saved cookies',async t => {
  const root = temporary(t);await connectTestOzon(root);
  const path = join(root,'.secrets/ozon/session.json'),before = readFileSync(path);
  let account = 999,released = 0;
  const client = new OzonClient(root,{
    browser:async () => ({close:async () => {released++;},read:async captured => ({version:2,request_url:captured.url,
      user_agent:'Synthetic test browser',http_status:200,outcome:'json_received',data:ozonPage({account}),
      exported:{cookies:[{name:'session',value:'fresh-synthetic',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,session:true}]}})})});
  t.after(() => client.close());
  await client.open();assert.equal(client.source,'browser');
  await assert.rejects(client.lists(),error => error.code === 'context_mismatch');assert.deepEqual(readFileSync(path),before);
  account = 123;await client.lists();await client.close();assert.equal(released,1);
  const saved = await OzonSession.open(path,'bootstrap=disabled');
  assert.match(await saved.header(request.url),/session=fresh-synthetic/);
});

async function serverFixture(t) {
  const state = fixture(t),service = createRecoveryServer(state.pool);
  service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
  t.after(() => service.close());
  return {...state,async channel() {
    const socket = connect({port:service.server.address().port,host:'127.0.0.1'});
    socket.on('error',() => {});await once(socket,'connect');
    const lines = createInterface({input:socket})[Symbol.asyncIterator]();let sequence = 0;
    t.after(() => socket.destroy());
    return {send:async message => {
      const id = ++sequence;socket.write(JSON.stringify({...message,version:2,id})+'\n');
      const line = await lines.next();assert.equal(line.done,false);
      const result = JSON.parse(line.value);assert.equal(result.id,id);assert.equal(result.version,2);return result;
    }};
  }};
}

test('the socket protocol resumes a warm browser and releases a collection without closing Chrome',async t => {
  const {workers,channel} = await serverFixture(t);
  const cold = await channel();assert.equal((await cold.send({resume:true})).available,false);assert.equal(workers.length,0);
  const first = await channel();assert.equal((await first.send({request,cookies:[]})).worker,1);
  assert.equal((await first.send({close:true})).released,true);assert.equal(workers[0].closed,false);
  const warm = await channel();assert.equal((await warm.send({resume:true})).available,true);
  assert.equal((await warm.send({request})).worker,1);
  assert.equal((await warm.send({close:true})).browser_closed,false);assert.equal(workers.length,1);
});

test('the socket protocol waits for login to close before handing the profile back to collection',async t => {
  const {workers,channel} = await serverFixture(t);
  const first = await channel();await first.send({request});await first.send({close:true});
  const login = await channel();await login.send({login:'start',request,phone:'+79990000000'});
  assert.equal(workers[0].closed,true);assert.equal(workers[1].persistent,false);
  const next = await channel();let entered = false;
  const waiting = next.send({request}).then(value => {entered = true;return value;});
  await turn();assert.equal(entered,false);
  assert.equal((await login.send({close:true})).browser_closed,true);
  assert.equal((await waiting).worker,3);assert.equal(workers[1].closed,true);
  await next.send({close:true});
});
