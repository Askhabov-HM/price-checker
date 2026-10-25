import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {LamodaDesktop} from '../src/providers/lamoda/desktop.js';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {Tracker} from '../src/service.js';
import {makeServer,listen} from '../src/web.js';
import {Authentication,createCredentials} from '../src/auth.js';
import {collectWishlistPages,CdpConnection,WindowsLamodaBrowser} from '../apps/lamoda-windows/cdp-browser.js';
import {DesktopCredentials,collectOnce} from '../apps/lamoda-windows/desktop-api.js';
import {LamodaError} from '../src/providers/lamoda/parser.js';
import {temporary,cleanup} from './helpers.js';

const accountDigest = createHash('sha256').update('lamoda:42').digest('hex');
const favorites = ['SYNTHETIC001','SYNTHETIC002'];
const pageState = page => ({
  user:{customer:{id:42,is_active:true},wishlist:favorites.map(product_sku => ({product_sku})),private_profile:'exclude'},
  payload:{pagination:{page,limit:1,offset:page-1,found:2,pages:2},products:[{
    sku:favorites[page-1],name:'Example',brand:{name:'Brand'},seo_tail:'example',price_iso_code:'RUB',
    prices:[{price:'120',private_discount:'exclude'},{price:'100'}],is_available:true,is_sellable:true,private_field:'exclude'}]},
});
const html = state => `<script>var __NUXT__ = {\n        user: ${JSON.stringify(state.user)},\n        payload: ${JSON.stringify(state.payload)},\n};</script>`;

test('Windows page reader validates every page and strips unrelated Lamoda state',async () => {
  const calls = [];
  const result = await collectWishlistPages(async page => {calls.push(page);return html(pageState(page));},accountDigest);
  assert.deepEqual(calls,[1,2]);assert.equal(result.count,2);
  assert.equal(JSON.stringify(result.pages).includes('private_'),false);
  assert.deepEqual(result.pages[0].payload.products[0].prices,[{price:'120'},{price:'100'}]);
  await assert.rejects(collectWishlistPages(async page => html(pageState(page)), '0'.repeat(64)),error => error.code === 'account_mismatch');
});

test('Desktop snapshots are idempotent and isolated from production price tables',async t => {
  const root = temporary(t),db = new LamodaDatabase(root),desktop = new LamodaDesktop(db);
  cleanup(t,() => db.close());db.bindAccount('42');
  const invite = desktop.pairing(),token = desktop.pair(invite.code,'Test Windows').token;
  assert.equal(desktop.authenticate('Bearer '+token),true);
  assert.equal(JSON.stringify(desktop.status()).includes(token),false);
  const pages = [pageState(1),pageState(2)],run = 'a'.repeat(32);
  const first = await desktop.record(run,pages);assert.equal(first.count,2);assert.equal(first.duplicate,false);
  assert.equal((await desktop.record(run,pages)).duplicate,true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM desktop_snapshots').get().n,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM checks').get().n,0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM products').get().n,0);
  assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM desktop_snapshots').get()).includes('private_'),false);
  const changed = structuredClone(pages);changed[1].payload.products[0].prices[1].price='90';
  await assert.rejects(desktop.record(run,changed),error => error.code === 'incomplete_data');
  await assert.rejects(desktop.record('b'.repeat(32),pages.slice(0,1)),error => error.code === 'incomplete_data');
  const wrong = structuredClone(pages);wrong.forEach(page => page.user.customer.id=99);
  await assert.rejects(desktop.record('c'.repeat(32),wrong),error => error.code === 'account_mismatch');
  await desktop.revoke();assert.equal(desktop.authenticate('Bearer '+token),false);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM desktop_snapshots').get().n,1);
});

test('Desktop stage waits for the shared queue and rejects a late result',async t => {
  let now = Date.now();
  const root = temporary(t),lamoda = new LamodaService(root,{current:() => now,logger:() => {},pushSender:{configured:() => false}});
  cleanup(t,() => lamoda.close());lamoda.db.bindAccount('42');
  const releaseOther = Promise.withResolvers();
  const other = lamoda.collectionQueue.enqueue('ozon',() => releaseOther.promise);
  await other.ready;
  const job = lamoda.desktop.start();assert.equal(job.status,'queued');
  assert.equal(lamoda.desktop.getJob(job.id).status,'queued');
  releaseOther.resolve();await other.done;
  for (let attempt=0;lamoda.desktop.getJob(job.id).status==='queued' && attempt<20;attempt++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(lamoda.desktop.getJob(job.id).status,'active');
  now += 10*60000;
  await assert.rejects(lamoda.desktop.recordJob(job.id,'d'.repeat(32),[pageState(1),pageState(2)]),error => error.code === 'interrupted');
  assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM desktop_snapshots').get().n,0);
  await lamoda.desktop.job.ticket.done;
  assert.equal(lamoda.collectionQueue.status('lamoda').active_store,null);
});

test('Desktop Retry-After survives the job and pauses Lamoda without changing its schedule',async t => {
  let now = Date.now();
  const root = temporary(t),lamoda = new LamodaService(root,{current:() => now,logger:() => {},pushSender:{configured:() => false}});
  cleanup(t,() => lamoda.close());lamoda.db.bindAccount('42');
  const before = lamoda.config(),issued = lamoda.desktop.start();
  for (let attempt=0;lamoda.desktop.getJob(issued.id).status==='queued' && attempt<20;attempt++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(lamoda.desktop.getJob(issued.id).status,'active');
  lamoda.desktop.fail(issued.id,{code:'rate_limited',retry_after_ms:3600000});
  await lamoda.desktop.job.ticket.done;
  assert.equal(Date.parse(lamoda.desktop.notBefore()),now+3600000);
  assert.deepEqual(lamoda.config(),before);
  assert.throws(() => lamoda.desktop.start(),/пауза/);
  await assert.rejects(lamoda.start(),/пауза/);
  now += 3600001;
  const next = lamoda.desktop.start();assert.notEqual(next.id,issued.id);
  lamoda.desktop.fail(next.id);
});

test('Desktop HTTP API requires owner pairing and accepts only a scoped device token',async t => {
  const root = temporary(t),lamoda = new LamodaService(root,{logger:() => {},pushSender:{configured:() => false}}),tracker = new Tracker(root);
  lamoda.db.bindAccount('42');cleanup(t,async () => {await lamoda.close();await tracker.close();});
  const auth = new Authentication(await createCredentials('owner','synthetic-test-password'));
  const server = makeServer(tracker,{lamoda,auth}),port = await listen(server,0),base = 'http://127.0.0.1:'+port;
  cleanup(t,async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const post = (path,body = {},headers = {}) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/providers/lamoda/desktop/pairing')).status,401);
  const anon = await (await fetch(base+'/api/auth')).json();
  const login = await post('/api/login',{login:'owner',password:'synthetic-test-password'},{'X-CSRF-Token':anon.csrf_token});
  const session = await login.json(),cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/providers/lamoda/desktop/pairing',{}, {Cookie:cookie})).status,403);
  const invite = await (await post('/api/providers/lamoda/desktop/pairing',{},
    {Cookie:cookie,'X-CSRF-Token':session.csrf_token})).json();
  const paired = await (await post('/api/lamoda-desktop/pair',{code:invite.code})).json();
  const device = {Authorization:'Bearer '+paired.token};
  assert.equal((await post('/api/providers/lamoda/desktop/schedule',{enabled:true},device)).status,401);
  const schedule = await (await post('/api/providers/lamoda/desktop/schedule',{enabled:true},
    {Cookie:cookie,'X-CSRF-Token':session.csrf_token})).json();
  assert.equal(schedule.enabled,true);assert.equal(schedule.interval_minutes,3);
  assert.equal((await fetch(base+'/api/providers/lamoda/status',{headers:device})).status,401);
  assert.equal((await post('/api/lamoda-desktop/snapshot',{run_id:'a'.repeat(32),pages:[pageState(1),pageState(2)]})).status,401);
  assert.equal((await fetch(base+'/api/lamoda-desktop/config',{headers:{...device,Origin:'https://other.example'}})).status,403);
  const config = await (await fetch(base+'/api/lamoda-desktop/config',{headers:device})).json();
  assert.equal(config.mode,'staging');assert.equal(config.account_digest,accountDigest);
  assert.equal(config.schedule.enabled,true);
  const started = await (await post('/api/lamoda-desktop/start',{},device)).json();
  let job = started.job;
  for (let attempt=0;job.status==='queued' && attempt<20;attempt++) {
    await new Promise(resolve => setTimeout(resolve,10));
    job = (await (await fetch(base+'/api/lamoda-desktop/job?id='+job.id,{headers:device})).json()).job;
  }
  assert.equal(job.status,'active');
  await assert.rejects(lamoda.start(),/ПК/);
  const saved = await post('/api/lamoda-desktop/snapshot',{job_id:job.id,run_id:'a'.repeat(32),pages:[pageState(1),pageState(2)]},device);
  assert.equal(saved.status,200);assert.equal((await saved.json()).count,2);
  const retry = await post('/api/lamoda-desktop/snapshot',{job_id:job.id,run_id:'a'.repeat(32),pages:[pageState(1),pageState(2)]},device);
  assert.equal(retry.status,200);assert.equal((await retry.json()).duplicate,true);
  assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,0);
  const status = await (await fetch(base+'/api/providers/lamoda/desktop/status',{headers:{Cookie:cookie}})).json();
  assert.equal(status.latest.item_count,2);
  const dashboard = await (await fetch(base+'/api/providers/lamoda/desktop/dashboard',{headers:{Cookie:cookie}})).json();
  assert.equal(dashboard.items.length,2);assert.equal(dashboard.history.length,1);
  assert.equal(dashboard.items[0].price,10000);
  const detail = await (await fetch(base+'/api/providers/lamoda/desktop/product/'+dashboard.items[0].id+'/history?days=30',
    {headers:{Cookie:cookie}})).json();
  assert.equal(detail.points.length,1);
});

test('Desktop credentials store only a protected token and a staged run uses one upload',async t => {
  const root = temporary(t),token = 'a'.repeat(43);
  const credentials = new DesktopCredentials({environment:{LOCALAPPDATA:root},seal:async () => 'opaque-blob',
    open:async value => {assert.equal(value,'opaque-blob');return token;}});
  await credentials.save('https://prices.example',token);
  assert.equal(readFileSync(join(root,'PriceChecker','LamodaCollector','desktop-device.json'),'utf8').includes(token),false);
  assert.deepEqual(await credentials.load(),{origin:'https://prices.example',token});
  let uploads = 0,firstRunId;
  const browser = {async collect(expected) {assert.equal(expected,accountDigest);return {count:2,pages:[pageState(1),pageState(2)]};}};
  const result = await collectOnce({credentials,browser,acquire:async () => async () => {},wait:async () => {},apiFactory:origin => ({
    async config(given) {assert.equal(origin,'https://prices.example');assert.equal(given,token);return {mode:'staging',account_digest:accountDigest};},
    async start(given) {assert.equal(given,token);return {job:{id:'b'.repeat(32),status:'active',expires_at:new Date(Date.now()+600000).toISOString()}};},
    async snapshot(given,jobId,id,pages) {
      uploads++;assert.equal(given,token);assert.equal(jobId,'b'.repeat(32));assert.equal(pages.length,2);
      if (uploads === 1) {firstRunId = id;throw Object.assign(new Error('Lost response'),{status:503});}
      assert.equal(id,firstRunId);
      return {run_id:id,count:2,received_at:'2026-10-24T00:00:00.000Z'};
    },
    async fail() {assert.fail('Successful run must not fail its job');},
  })});
  assert.equal(uploads,2);assert.equal(result.count,2);
});

test('An unverified wishlist page ends a desktop job without reopening Chrome',async t => {
  const root = temporary(t),token = 'a'.repeat(43);
  const credentials = new DesktopCredentials({environment:{LOCALAPPDATA:root},open:async () => token});
  mkdirSync(credentials.directory,{recursive:true});
  writeFileSync(credentials.path,JSON.stringify({version:1,origin:'https://prices.example',protected_token:'opaque'}));
  let reads = 0,failed = null;
  await assert.rejects(collectOnce({credentials,acquire:async () => async () => {},
    browser:{async collect() {reads++;throw new LamodaError('account_unverified');}},
    apiFactory:() => ({
      async config() {return {mode:'staging',account_digest:accountDigest};},
      async start() {return {job:{id:'b'.repeat(32),status:'active',expires_at:new Date(Date.now()+600000).toISOString()}};},
      async fail(_token,_jobId,error) {failed=error.code;},
    })}),error => error.code === 'account_unverified');
  assert.equal(reads,1);assert.equal(failed,'account_unverified');
});

test('CDP replies are matched by id without executing a browser',async () => {
  const socket = new EventEmitter();socket.readyState = 1;
  socket.addEventListener = (name,handler) => socket.on(name,handler);
  socket.send = data => {const request = JSON.parse(data);queueMicrotask(() => socket.emit('message',{data:JSON.stringify({id:request.id,result:{ok:true}})}));};
  socket.close = () => {socket.readyState = 3;socket.emit('close');};
  const connection = new CdpConnection(socket);
  assert.deepEqual(await connection.call('Runtime.evaluate',{expression:'1+1'},'session'),{ok:true});
  connection.close();
  await assert.rejects(connection.call('Target.getTargets'),error => error.code === 'browser_unavailable');
});

test('Windows collector reuses its private CDP profile and closes only its background tab',async t => {
  const root = temporary(t),profile = join(root,'PriceChecker','LamodaCollector','Chrome');
  mkdirSync(profile,{recursive:true});
  writeFileSync(join(profile,'DevToolsActivePort'),'9234\n/devtools/browser/synthetic\n');
  const calls = [];let page = 1,polls = 0;
  const connection = {async call(method,params) {
    calls.push(method);
    if (method === 'Target.createTarget') return {targetId:'private-tab'};
    if (method === 'Target.attachToTarget') return {sessionId:'private-session'};
    if (method === 'Page.navigate') {page=Number(new URL(params.url).searchParams.get('page'));polls=0;return {};}
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('({origin:location.origin'))
        return {result:{value:{origin:'https://www.lamoda.ru',ready:'complete'}}};
      if (params.expression.includes('state_count')) {
        polls++;
        const location = {href:'https://www.lamoda.ru/wishlist/?page='+page,origin:'https://www.lamoda.ru'};
        const document = {readyState:'complete',scripts:polls === 1 ? [] : [{textContent:'var __NUXT__ = {}'}]};
        return {result:{value:Function('location','document','URL','return '+params.expression)(location,document,URL)}};
      }
      if (params.expression === 'document.documentElement.outerHTML') return {result:{value:html(pageState(page))}};
      assert.fail('Unexpected page evaluation');
    }
    if (method === 'Browser.close') assert.fail('Existing browser must remain open');
    return {};
  },close() {calls.push('socket-close');}};
  const browser = new WindowsLamodaBrowser({platform:'win32',environment:{LOCALAPPDATA:root},
    fetchPage:async () => ({ok:true,json:async () => ({webSocketDebuggerUrl:'ws://127.0.0.1:9234/devtools/browser/synthetic'})}),
    connect:async () => connection,spawnProcess:() => assert.fail('Existing Chrome must be reused')});
  const result = await browser.collect(accountDigest);
  assert.equal(result.count,2);assert.equal(result.pages.length,2);
  assert.equal(calls.filter(value => value === 'Page.navigate').length,1);
  assert.deepEqual(calls.filter(value => value === 'Target.closeTarget'),['Target.closeTarget']);
  assert.equal(calls.includes('Browser.close'),false);
});

test('Desktop schedule stays separate from Android and indexes snapshots for the PC page',async t => {
  let now = Date.now();
  const root = temporary(t),lamoda = new LamodaService(root,{current:() => now,logger:() => {},pushSender:{configured:() => false}});
  cleanup(t,() => lamoda.close());lamoda.db.bindAccount('42');
  const invitation = lamoda.desktop.pairing();lamoda.desktop.pair(invitation.code,'Test laptop');
  const androidSettings = lamoda.config();
  assert.equal(lamoda.desktop.schedule().enabled,false);
  const settings = lamoda.desktop.setSchedule(true);
  assert.equal(settings.interval_minutes,3);
  assert.equal(Date.parse(settings.next_check),now+180000);
  assert.deepEqual(lamoda.config(),androidSettings);
  assert.throws(() => lamoda.desktop.start({scheduled:true}),/пока не назначен/);
  now += 180000;
  const job = lamoda.desktop.start({scheduled:true});
  for (let attempt=0;lamoda.desktop.getJob(job.id).status==='queued' && attempt<20;attempt++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(lamoda.desktop.getJob(job.id).status,'active');
  now += 30000;
  const saved = await lamoda.desktop.recordJob(job.id,'e'.repeat(32),[pageState(1),pageState(2)]);
  assert.equal(saved.count,2);
  assert.equal(Date.parse(lamoda.desktop.schedule().next_check),Date.parse(settings.next_check)+180000);
  const dashboard = lamoda.desktop.dashboard();
  assert.equal(dashboard.items.length,2);assert.equal(dashboard.history.length,1);
  assert.equal(dashboard.activity[0].status,'success');
  assert.equal(dashboard.items[0].price,10000);
  assert.equal(lamoda.desktop.detail(dashboard.items[0].id,30).points.length,1);
  assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,0);
  assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM checks').get().n,0);
  assert.deepEqual(lamoda.config(),androidSettings);
  await lamoda.desktop.job.ticket.done;
  now = Date.parse(lamoda.desktop.schedule().next_check);
  const lost = lamoda.desktop.start({scheduled:true});
  for (let attempt=0;lamoda.desktop.getJob(lost.id).status==='queued' && attempt<20;attempt++) await new Promise(resolve => setTimeout(resolve,5));
  lamoda.desktop.fail(lost.id,{code:'login_required'});
  assert.equal(lamoda.desktop.schedule().action_required,true);
  assert.equal(lamoda.desktop.schedule().next_check,null);
  assert.throws(() => lamoda.desktop.start({scheduled:true}),/пока не назначен/);
  lamoda.desktop.setSchedule(true);
  assert.equal(lamoda.desktop.schedule().action_required,false);
  lamoda.desktop.setSchedule(false);
  assert.equal(lamoda.desktop.schedule().next_check,null);
});

test('Existing desktop snapshots are indexed on upgrade and errors stay on the PC page',async t => {
  let now = Date.now();
  const root = temporary(t),db = new LamodaDatabase(root);db.bindAccount('42');
  const desktop = new LamodaDesktop(db,{current:() => now});
  await desktop.record('f'.repeat(32),[pageState(1),pageState(2)]);
  db.db.exec('DELETE FROM desktop_observations; DELETE FROM desktop_indexed; DELETE FROM desktop_products;');
  db.close();
  const reopened = new LamodaDatabase(root),restored = new LamodaDesktop(reopened,{current:() => now});
  cleanup(t,() => reopened.close());
  assert.equal(restored.dashboard().items.length,2);
  now += 1000;
  restored.failure('browser_unavailable');
  const view = restored.dashboard();
  assert.equal(view.history.length,2);assert.equal(view.history[1].status,'error');
  assert.equal(view.items[0].status,'error');
  assert.equal(restored.detail(view.items[0].id,30).points.at(-1).status,'error');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,0);
});
