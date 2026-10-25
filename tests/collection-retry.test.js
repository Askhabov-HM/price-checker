import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {retryCollectionRead} from '../src/collection-retry.js';
import {collectionQueue} from '../src/collection-queue.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {OzonClient,OzonReadError} from '../src/providers/ozon/client.js';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {LamodaError} from '../src/providers/lamoda/parser.js';
import {connectTestOzon,responseBrowser,jsonResponse,ozonPage,favoriteTile} from './ozon-fixture.js';
import {temporary,cleanup} from './helpers.js';

test('four failed reads keep the queue leased through all retries, then admit the next store',async t => {
  const queue = collectionQueue(temporary(t)),events = [],entered = Promise.withResolvers(),continueRetry = Promise.withResolvers();
  cleanup(t,() => continueRetry.resolve());let calls = 0;
  const job = queue.enqueue('ozon',() => retryCollectionRead(async () => {events.push(++calls);throw Error('synthetic failure');},
    {retryable:() => true,pause:async ms => {assert.equal(ms,5000);entered.resolve();await continueRetry.promise;}}));
  await entered.promise;
  const next = queue.enqueue('lamoda',() => events.push('lamoda'));
  assert.deepEqual(events,[1]);assert.equal(queue.status('lamoda').queued,true);
  continueRetry.resolve();await assert.rejects(job.done,/synthetic failure/);await next.done;
  assert.deepEqual(events,[1,2,3,4,'lamoda']);
});

test('a controlled collection can stop after one failed read',async () => {
  let calls = 0;
  await assert.rejects(retryCollectionRead(async () => {calls++;throw new LamodaError('browser_unavailable');},
    {attempts:1,retryable:() => true,pause:async () => assert.fail('no retry pause expected')}),
  error => error.code === 'browser_unavailable');
  assert.equal(calls,1);
});

test('Ozon succeeds on its fourth attempt with one check and one saved price',async t => {
  const root = temporary(t);await connectTestOzon(root);let calls = 0;const retries = [];
  const client = new OzonClient(root,{browser:responseBrowser(async () => {
    if (++calls < 4) throw Error('synthetic connection loss');
    const page = ozonPage();page.widgetStates['tileGridDesktop-8-default-1'] = JSON.stringify({items:[favoriteTile()]});return jsonResponse(page);
  })});
  const service = new OzonService(root,{client,pause:async () => {},logger:event => retries.push(event)});cleanup(t,() => service.close());
  await service.start();await service.running;
  assert.equal(calls,4);assert.deepEqual(retries.map(event => event.attempt),[2,3,4]);
  assert.equal(service.db.checks().length,1);assert.equal(service.db.checks()[0].status,'success');
  assert.equal(service.db.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,1);
});

test('Ozon account errors and explicit Retry-After release the queue after one read',async t => {
  for (const error of [new OzonReadError('context_mismatch'),new OzonReadError('login_required'),new OzonReadError('rate_limited',60000)]) {
    const root = temporary(t);let calls = 0;
    const service = new OzonService(root,{pause:async () => assert.fail('must not wait'),client:{configured:() => true,
      open:async () => 'synthetic',lists:async () => {calls++;throw error;},close:async () => {}}});cleanup(t,() => service.close());
    service.login.require = async () => {};
    await service.start();await service.running;
    assert.equal(calls,1);assert.equal(service.db.checks()[0].status,'error');
    assert.equal(await service.collectionQueue.enqueue('lamoda',() => 'next').done,'next');
  }
});

test('shutdown interrupts the retry pause and no new Ozon read starts',async t => {
  const root = temporary(t),entered = Promise.withResolvers();let calls = 0;
  const service = new OzonService(root,{client:{configured:() => true,open:async () => 'synthetic',close:async () => {},
    lists:async () => {calls++;throw new OzonReadError('network_error');}},
    pause:async (_ms,_value,{signal}) => {entered.resolve();await new Promise((_,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));},logger:() => {}});
  cleanup(t,async () => {if (!service.closing) await service.close();});
  await service.start();await entered.promise;
  const next = service.collectionQueue.enqueue('lamoda',() => 'next');
  await service.close();await next.done;assert.equal(calls,1);
});

test('Lamoda retries three browser failures and writes a single result and notification',async t => {
  const root = temporary(t);let calls = 0;const events = [];
  const service = new LamodaService(root,{pause:async () => {},logger:event => events.push(event),channel:() => ({available:() => true,
    request:async () => {if (++calls < 4) throw new LamodaError('browser_unavailable');return {account_id:'42',items:[]};}})});
  cleanup(t,() => service.close());service.db.bindAccount('42');await service.start();await service.running;
  assert.equal(calls,4);assert.equal(service.db.checks().length,1);assert.equal(service.db.checks()[0].status,'success');
  assert.equal(service.db.pending().length,1);assert.equal(events.filter(event => event.event === 'collection_retry').length,3);
});

test('Lamoda retries keep the original Android deadline and stop when the ten minutes expire',async t => {
  const root = temporary(t);let now = Date.now(),calls = 0;const deadlines = [];
  const service = new LamodaService(root,{current:() => now,pause:async ms => {now+=ms;},logger:() => {}});cleanup(t,() => service.close());
  service.mobile.pair(service.mobile.pairing().code,'Synthetic Android');service.db.bindAccount('42');
  service.mobile.collect = async (_check,_signal,{expires}) => {
    deadlines.push(expires);calls++;now+=2*60000;throw new LamodaError('incomplete_data');
  };
  const deadline = now+10*60000;
  await service.start();await service.running;
  assert.equal(calls,4);assert.ok(deadlines.every(value => value === deadline));
  assert.equal(service.db.checks().length,1);assert.equal(service.db.checks()[0].status,'error');
  // Expiry during the pause must not create a fresh ten-minute Android job.
  now = Date.now();calls = 0;
  service.mobile.collect = async () => {calls++;now+=10*60000-1000;throw new LamodaError('incomplete_data');};
  await service.start();await service.running;
  assert.equal(calls,1);assert.equal(service.db.checks()[0].status,'interrupted');
});

test('Lamoda replaces failed Android jobs within one check and frees the queue after four failures',async t => {
  const root = temporary(t),now = Date.now(),ids = new Set();
  const service = new LamodaService(root,{current:() => now,pause:async () => {},logger:() => {}});cleanup(t,() => service.close());
  service.mobile.pair(service.mobile.pairing().code,'Synthetic Android');service.db.bindAccount('42');
  await service.start({trigger:'android'});
  const next = service.collectionQueue.enqueue('ozon',() => 'next');
  for (let attempt = 0; attempt < 4; attempt++) {
    let job;
    for (let poll = 0; poll < 200; poll++) {
      job = service.mobile.next();
      if (job && !ids.has(job.id)) break;
      await delay(10);
    }
    assert.ok(job && !ids.has(job.id),'a fresh Android job must be available');
    ids.add(job.id);assert.equal(job.expires,now+10*60000);
    assert.equal(service.collectionQueue.status('ozon').queued,true);
    service.mobile.fail(job.id,'access_limited');
  }
  await service.running;assert.equal(await next.done,'next');
  assert.equal(ids.size,4);assert.equal(service.mobile.next(),null);
  assert.equal(service.db.checks().length,1);assert.equal(service.db.checks()[0].status,'error');
});
