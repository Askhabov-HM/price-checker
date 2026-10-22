import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CollectionQueue,acquireCollection} from '../src/collection-queue.js';
import {Tracker} from '../src/service.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {makeServer,listen} from '../src/web.js';
import {Authentication,createCredentials} from '../src/auth.js';
import {temporary,cleanup} from './helpers.js';

test('FIFO coalesces a store and retains ownership through failure cleanup',async t => {
  const queue = new CollectionQueue(temporary(t)),events = [];
  const finish = Promise.withResolvers(),cleaned = Promise.withResolvers(),cleaning = Promise.withResolvers();
  cleanup(t,() => {finish.resolve();cleaned.resolve();});
  const first = queue.enqueue('ozon',async () => {
    events.push('ozon');
    try {await finish.promise;throw Error('synthetic failure');}
    finally {cleaning.resolve();await cleaned.promise;events.push('closed');}
  });
  await first.ready;
  const second = queue.enqueue('lamoda',() => events.push('lamoda'));
  assert.equal(queue.enqueue('lamoda',() => assert.fail('duplicate')),second);
  const third = queue.enqueue('randewoo',() => events.push('randewoo'));
  assert.deepEqual(queue.status('randewoo'),{queued:true,queue_position:2,active_store:'ozon'});
  finish.resolve();await cleaning.promise;
  assert.deepEqual(events,['ozon']);assert.equal(queue.status('ozon').queued,false);
  cleaned.resolve();await assert.rejects(first.done,/synthetic failure/);
  await Promise.all([second.done,third.done]);
  assert.deepEqual(events,['ozon','closed','lamoda','randewoo']);
  assert.deepEqual(queue.status('ozon'),{queued:false,queue_position:null,active_store:null});
});

test('canceling a waiting job never interrupts the active store or leaves a blocked queue',async t => {
  const queue = new CollectionQueue(temporary(t)),finish = Promise.withResolvers(),controller = new AbortController();
  cleanup(t,() => finish.resolve());
  const active = queue.enqueue('ozon',() => finish.promise);await active.ready;
  const canceled = queue.enqueue('lamoda',() => assert.fail('canceled job ran'),{signal:controller.signal});
  controller.abort();await assert.rejects(canceled.done,{name:'AbortError'});
  assert.equal(queue.status('ozon').active_store,'ozon');
  const later = queue.enqueue('randewoo',() => 'ok');
  finish.resolve();await active.done;assert.equal(await later.done,'ok');
});

test('aborting active work keeps the next store blocked until cleanup really finishes',async t => {
  const queue = new CollectionQueue(temporary(t)),finish = Promise.withResolvers(),controller = new AbortController();
  cleanup(t,() => finish.resolve());
  const active = queue.enqueue('ozon',() => finish.promise,{signal:controller.signal});await active.ready;
  let ran = false;const next = queue.enqueue('lamoda',() => {ran = true;});
  controller.abort();assert.equal(ran,false);assert.equal(queue.status('lamoda').active_store,'ozon');
  finish.resolve();await active.done;await next.done;assert.equal(ran,true);
});

test('a separate process and a local queue honor the same collection lock', {timeout:10000},async t => {
  const root = temporary(t),module = pathToFileURL(join(process.cwd(),'src/collection-queue.js')).href;
  const release = await acquireCollection(root);let released = false;
  const code = `import {acquireCollection} from ${JSON.stringify(module)};
    let announced=false;
    const release=await acquireCollection(${JSON.stringify(root)},undefined,()=>{if(!announced){announced=true;process.send('waiting');}});
    process.send('active');await new Promise(resolve=>process.once('message',resolve));await release();process.disconnect();`;
  const child = spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr = '';child.stderr.on('data',chunk => {stderr += chunk;});
  const exited = once(child,'exit');
  cleanup(t,async () => {if (!released) await release();if (child.exitCode === null) {child.kill();await exited;}});
  assert.equal((await once(child,'message'))[0],'waiting');
  const started = once(child,'message');await release();released = true;
  assert.equal((await started)[0],'active');
  let ran = false;
  const queue = new CollectionQueue(root),job = queue.enqueue('randewoo',() => {ran = true;});
  await job.ready;assert.equal(ran,false);assert.equal(queue.status('randewoo').queued,true);
  child.send('finish');assert.deepEqual(await exited,[0,null],stderr);
  await job.done;assert.equal(ran,true);
});

test('all three services share FIFO admission, bound duplicates and wait for Ozon to close',async t => {
  const root = temporary(t),events = [],entered = Promise.withResolvers(),finish = Promise.withResolvers(),closing = Promise.withResolvers(),closed = Promise.withResolvers();
  const tracker = new Tracker(root,{client:{authorizedUser:async () => {events.push('randewoo');entered.resolve();await finish.promise;},
    cart:async () => [],favorites:async () => [],close() {finish.resolve();}}});
  const ozon = new OzonService(root,{client:{configured:() => true,open:async () => {events.push('ozon');return 'synthetic-account';},
    lists:async () => ({favorites:[]}),close:async () => {closing.resolve();await closed.promise;events.push('ozon closed');}}});
  const lamoda = new LamodaService(root,{logger:() => {},pushSender:{configured:() => false},channel:() => ({available:() => true,request:async () => {
    events.push('lamoda');return {account_id:'42',items:[]};
  }})});lamoda.db.bindAccount('42');
  cleanup(t,async () => {finish.resolve();closed.resolve();await Promise.all([tracker.close(),ozon.close(),lamoda.close()]);});
  const first = tracker.refreshNow();await entered.promise;
  await ozon.start();await lamoda.start();
  assert.equal(ozon.status().queued,true);assert.equal(lamoda.status().queue_position,2);
  assert.equal(ozon.status().checks.length,0);assert.equal(lamoda.status().checks.length,0);
  assert.equal(tracker.startRefresh(),false);await assert.rejects(ozon.start());await assert.rejects(lamoda.start());
  finish.resolve();await first;await closing.promise;
  assert.deepEqual(events,['randewoo','ozon']);assert.equal(lamoda.status().queued,true);
  closed.resolve();await Promise.all([ozon.running,lamoda.running]);
  assert.deepEqual(events,['randewoo','ozon','ozon closed','lamoda']);
  assert.equal(ozon.status().checks[0].status,'success');assert.equal(lamoda.status().checks[0].status,'success');
});

test('shutdown cancels a queued service without waiting for another store',async t => {
  const root = temporary(t),finish = Promise.withResolvers();
  const queue = new CollectionQueue(root),active = queue.enqueue('external',() => finish.promise);await active.ready;
  const ozon = new OzonService(root,{client:{configured:() => true,open:async () => assert.fail('closed service ran')}});
  cleanup(t,async () => {finish.resolve();await active.done;if (!ozon.closing) await ozon.close();});
  await ozon.start();assert.equal(ozon.status().queued,true);
  await ozon.close();assert.equal(ozon.collectionQueue.status('ozon').queued,false);
  finish.resolve();await active.done;
});

test('a disabled schedule is rechecked before a queued collector starts',async t => {
  const root = temporary(t),finish = Promise.withResolvers();
  const ozon = new OzonService(root,{client:{configured:() => true,open:async () => assert.fail('disabled schedule ran')}});
  const active = ozon.collectionQueue.enqueue('randewoo',() => finish.promise);await active.ready;
  cleanup(t,async () => {finish.resolve();await active.done;await ozon.close();});
  ozon.settings({schedule_enabled:true});await ozon.start({trigger:'schedule'});
  ozon.settings({schedule_enabled:false});finish.resolve();await ozon.running;
  assert.equal(ozon.status().checks.length,0);assert.equal(ozon.status().schedule_enabled,false);
});

test('Android requests retry while queued and receive a job and push only after admission',async t => {
  const root = temporary(t),finish = Promise.withResolvers(),entered = Promise.withResolvers(),collecting = Promise.withResolvers();
  const tracker = new Tracker(root,{client:{authorizedUser:async () => {entered.resolve();await finish.promise;},
    cart:async () => [],favorites:async () => [],close() {finish.resolve();}}});
  const lamoda = new LamodaService(root,{logger:() => {},pushSender:{configured:() => true,project:'synthetic-project'}});
  const original = lamoda.mobile.collect.bind(lamoda.mobile);
  lamoda.mobile.collect = (...args) => {const work = original(...args);collecting.resolve();return work;};
  const paired = lamoda.mobile.pair(lamoda.mobile.pairing().code,'Synthetic Android');
  lamoda.push.register({token:'synthetic-registration-token',enabled:true,project_id:'synthetic-project'});
  const auth = new Authentication(await createCredentials('owner','synthetic-test-password'));
  const server = makeServer(tracker,{lamoda,auth}),port = await listen(server,0),base = 'http://127.0.0.1:'+port;
  cleanup(t,async () => {
    finish.resolve();server.closeAllConnections();await new Promise(resolve => server.close(resolve));
    await Promise.all([lamoda.close(),tracker.close()]);
  });
  tracker.startRefresh();await entered.promise;
  const headers = {Authorization:'Bearer '+paired.token,'Content-Type':'application/json'};
  const started = await fetch(base+'/api/lamoda-mobile/start',{method:'POST',headers,body:'{}'});
  assert.equal(started.status,503);assert.equal(started.headers.get('Retry-After'),'5');
  assert.equal(lamoda.mobile.next(),null);assert.equal(lamoda.db.checks().length,0);
  assert.equal((await fetch(base+'/api/lamoda-mobile/next',{headers})).status,503);
  finish.resolve();await collecting.promise;
  const result = await (await fetch(base+'/api/lamoda-mobile/next',{headers})).json();assert.ok(result.job);
  assert.equal(lamoda.db.db.prepare('SELECT COUNT(*) AS n FROM mobile_push_outbox').get().n,1);
  await lamoda.stopMobile(result.job.id);
});
