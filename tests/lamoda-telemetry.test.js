import test from 'node:test';
import assert from 'node:assert/strict';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {phoneEvent} from '../src/providers/lamoda/mobile-telemetry.js';
import {Tracker} from '../src/service.js';
import {makeServer,listen} from '../src/web.js';
import {Authentication,createCredentials} from '../src/auth.js';
import {temporary,cleanup} from './helpers.js';

const id = n => n.toString(16).padStart(32,'0');
function service(t,options = {}) {
  const root = temporary(t),lamoda = new LamodaService(root,{pause:async () => {},logger:() => {},...options});
  cleanup(t,() => lamoda.close());
  const mobile=lamoda.mobile,token=mobile.pair(mobile.pairing().code,'Synthetic Android').token;
  return {root,lamoda,mobile,token};
}
const event = (n,overrides = {}) => ({event_id:id(n),process_id:id(999),seq:n,event:'PUSH_RECEIVED',event_at:'2026-11-04T10:00:00.000Z',...overrides});
const page = {user:{customer:{id:42,is_active:true},wishlist:[{product_sku:'SYNTHETIC01'}]},payload:{
  products:[{sku:'SYNTHETIC01',name:'Example',brand:{name:'Example'},seo_tail:'example',price_iso_code:'RUB',price_amount:'100',is_available:true,is_sellable:true}],
  pagination:{page:1,limit:60,offset:0,found:1,pages:1}}};

test('phone outbox batches are atomic, deduplicated, retain original event time and receive a separate VPS time',t => {
  const now=Date.parse('2026-11-04T11:00:00Z'),{mobile}=service(t,{current:()=>now});
  const value=event(1),first=mobile.telemetry.accept({events:[value]});
  assert.deepEqual(first.ack,[id(1)]);assert.equal(first.received_at,'2026-11-04T11:00:00.000Z');
  mobile.telemetry.accept({events:[value]});
  const rows=mobile.sql.prepare('SELECT event_at,received_at FROM mobile_phone_events').all();assert.equal(rows.length,1);
  assert.equal(rows[0].event_at,value.event_at);assert.equal(rows[0].received_at,first.received_at);
  assert.throws(()=>mobile.telemetry.accept({events:[event(2),event(3,{cookie:'synthetic-private'})]}));
  assert.equal(mobile.sql.prepare('SELECT COUNT(*) n FROM mobile_phone_events').get().n,1);
  assert.throws(()=>mobile.telemetry.accept({events:Array.from({length:51},(_,i)=>event(i+10))}));
});

test('telemetry schema refuses credentials, arbitrary text, malformed IDs and unbounded fields',()=>{
  for(const extra of [{token:'synthetic-private'},{message:'synthetic-private'},{url:'https://example.invalid/?secret=synthetic'},
    {http_status:900},{duration_ms:-1},{page:1001},{event_id:'invalid'},{event:'UNTRUSTED'},{screen_locked:'true'},{event_at:'invalid'},
    {action:'https://example.invalid'},{issue:'private-message'}]) assert.throws(()=>phoneEvent(event(1,extra)));
  assert.equal(phoneEvent(event(1,{http_status:401,issue:'AUTH',duration_ms:123,screen_locked:true})).http_status,401);
});

test('an early cancellation prevents a delayed manual start and never cancels the next run',async t=>{
  const {lamoda,mobile}=service(t);
  assert.equal((await lamoda.stopMobileRun(id(1))).outcome,'canceled');
  assert.equal((await lamoda.mobileRequest(id(1),{manual:true})).outcome,'canceled');assert.equal(lamoda.db.checks().length,0);
  const next=await lamoda.mobileRequest(id(2),{manual:true});assert.ok(next.job);
  await lamoda.stopMobileRun(id(1));assert.equal(mobile.next().id,next.job.id);
  await lamoda.stopMobileRun(id(2));assert.equal(lamoda.db.checks()[0].status,'interrupted');
});

test('manual start is idempotent after a lost response and a saved result cannot be undone',async t=>{
  const {lamoda,mobile}=service(t);
  const first=await lamoda.mobileRequest(id(1),{manual:true}),again=await lamoda.mobileRequest(id(1),{manual:true});
  assert.equal(first.job.id,again.job.id);assert.equal(lamoda.db.checks().length,1);
  await mobile.accept(first.job.id,1,page.user,page.payload);await lamoda.running;
  assert.equal((await lamoda.stopMobileRun(id(1))).outcome,'completed');
  assert.equal((await lamoda.mobileRequest(id(1),{manual:true})).job,null);
  assert.equal(lamoda.db.checks().length,1);assert.equal(lamoda.db.dashboard().items.length,1);
});

test('canceling while a start acquires its lock or final-page validation runs cannot publish prices',async t=>{
  const {lamoda,mobile}=service(t);
  const delayed=lamoda.mobileRequest(id(1),{manual:true});await lamoda.stopMobileRun(id(1));
  assert.equal((await delayed).outcome,'canceled');assert.equal(lamoda.db.checks().length,0);
  const second=await lamoda.mobileRequest(id(2),{manual:true});
  const upload=mobile.accept(second.job.id,1,page.user,page.payload),stop=lamoda.stopMobileRun(id(2));
  await upload.catch(()=>{});await stop;
  assert.equal(lamoda.db.dashboard().items.length,0);assert.equal(lamoda.db.checks()[0].status,'interrupted');
});

test('a push can cancel its known job before next, and an old run cannot claim a new scheduled check',async t=>{
  const {lamoda,mobile}=service(t);await lamoda.start();let job=mobile.next();
  await lamoda.stopMobileRun(id(1),job.id);assert.equal(lamoda.db.checks()[0].status,'interrupted');
  await lamoda.start();job=mobile.next();
  assert.equal((await lamoda.mobileRequest(id(1))).job,null);assert.equal(mobile.next().id,job.id);
  const view=await lamoda.mobileRequest(id(2),{expected:job.id});assert.equal(view.job.id,job.id);
  await lamoda.stopMobileRun(id(2));
});

test('canceling a queued run preserves the other store and the next scheduled check',async t=>{
  const {lamoda}=service(t);lamoda.db.bindAccount('42');lamoda.settings({schedule_enabled:true});
  const next=lamoda.status().next_check,held=Promise.withResolvers();cleanup(t,()=>held.resolve());
  const active=lamoda.collectionQueue.enqueue('randewoo',()=>held.promise);await active.ready;
  const waiting=await lamoda.mobileRequest(id(1),{manual:true});assert.equal(waiting.queued,true);
  assert.equal(lamoda.status().mobile.runtime.state,'queued');
  const stopped=await lamoda.stopMobileRun(id(1));assert.equal(stopped.outcome,'canceled');
  assert.equal(lamoda.collectionQueue.status('randewoo').active_store,'randewoo');
  assert.equal(lamoda.db.checks().length,0);assert.equal(lamoda.status().next_check,next);assert.equal(lamoda.status().schedule_enabled,true);
  held.resolve();await active.done;
});

test('job timeline includes pre-response run events even after the job payload was cleaned up',async t=>{
  const {lamoda,mobile}=service(t);const first=await lamoda.mobileRequest(id(1),{manual:true});
  mobile.telemetry.accept({events:[event(1,{event:'API',action:'start',phase:'BEGIN',run_id:id(1)})]});
  await lamoda.stopMobileRun(id(1));await lamoda.mobileRequest(id(2),{manual:true});
  assert.equal(mobile.sql.prepare('SELECT 1 FROM mobile_jobs WHERE id=?').get(first.job.id),undefined);
  assert.ok(mobile.telemetry.timeline(first.job.id).some(item=>item.event_id===id(1)));
  await lamoda.stopMobileRun(id(2));
});

test('re-pairing neither duplicates already received events nor lets old runs claim the new device',async t=>{
  const {mobile,lamoda}=service(t);mobile.telemetry.accept({events:[event(1)]});
  await lamoda.stopMobileRun(id(5));mobile.pair(mobile.pairing().code,'Replacement');
  mobile.telemetry.accept({events:[event(1)]});
  assert.equal(mobile.sql.prepare('SELECT COUNT(*) n FROM mobile_phone_events').get().n,1);
  await assert.rejects(lamoda.mobileRequest(id(5),{manual:true}),/прежнему подключению/);
});

test('late offline heartbeats do not look live and heartbeat delivery never extends the job deadline',async t=>{
  let now=Date.parse('2026-11-04T10:00:00Z');const {lamoda,mobile}=service(t,{current:()=>now});
  const view=await lamoda.mobileRequest(id(1),{manual:true}),expires=view.job.expires;
  now+=120000;mobile.telemetry.accept({events:[event(1,{job_id:view.job.id,event:'HEARTBEAT',stage:'reading',page:1})]});
  assert.equal(mobile.telemetry.runtime().state,'waiting');
  mobile.contact(view.job.id);assert.equal(mobile.telemetry.runtime().state,'running');
  now+=91000;assert.equal(mobile.telemetry.runtime().state,'silent');
  assert.equal(mobile.next().expires,expires);await lamoda.stopMobileRun(id(1));
});

test('native telemetry and run cancellation require the device token; owner timeline remains protected',async t=>{
  const {root,lamoda,token}=service(t),tracker=new Tracker(root);
  const authState=new Authentication(await createCredentials('owner','synthetic-test-password'));
  const server=makeServer(tracker,{lamoda,auth:authState});
  const port=await listen(server,0),base='http://127.0.0.1:'+port;
  cleanup(t,async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await tracker.close();});
  const post=(action,body,headers={})=>fetch(base+'/api/lamoda-mobile/'+action,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const auth={Authorization:'Bearer '+token};
  assert.equal((await fetch(base+'/api/providers/lamoda/mobile/timeline',{headers:auth})).status,401);
  assert.equal((await post('telemetry',{events:[event(1)]})).status,401);
  assert.equal((await post('telemetry',{events:[event(1)]},{...auth,Origin:'https://example.invalid'})).status,403);
  assert.equal((await post('telemetry',{events:[event(1)]},auth)).status,200);
  assert.equal((await fetch(base+'/api/lamoda-mobile/capabilities',{headers:auth})).status,200);
  assert.equal((await post('stop',{run_id:id(5)},auth)).status,200);
  const canceled=await(await post('start',{run_id:id(5)},auth)).json();assert.equal(canceled.outcome,'canceled');
  assert.equal((await post('telemetry',{events:[event(2,{token:'synthetic-private'})]},auth)).status,400);
  const active=await(await post('start',{run_id:id(6)},auth)).json();
  const rejected=await post('page',{job_id:active.job.id,page:1,user:{},payload:{}},auth);
  assert.equal(rejected.status,400);assert.equal((await rejected.json()).retryable,true);
  await post('stop',{run_id:id(6)},auth);
  const anon=await(await fetch(base+'/api/auth')).json();
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':anon.csrf_token},body:JSON.stringify({login:'owner',password:'synthetic-test-password'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const timeline=await fetch(base+'/api/providers/lamoda/mobile/timeline',{headers:{Cookie:cookie}});assert.equal(timeline.status,200);
  assert.ok((await timeline.json()).events.some(entry=>entry.source==='phone'));
});
