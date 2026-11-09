import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {phoneEvent} from '../src/providers/lamoda/mobile-telemetry.js';

const source=readFileSync(new URL('../apps/lamoda-android/app/src/main/assets/collector.js',import.meta.url),'utf8');
const user={customer:{id:42,is_active:true},wishlist:[]};
const script=(account=user,payload={products:[]})=>'var __NUXT__ = {\n        user: '+JSON.stringify(account)+',\n        payload: '+JSON.stringify(payload)+',\n};';
function collector({scripts=[script()],fetch:request,timeout}={}) {
  const calls=[];
  const context={location:{origin:'https://www.lamoda.ru'},AbortController,TextDecoder,TextEncoder,
    setTimeout:timeout||setTimeout,clearTimeout,
    DOMParser:class {parseFromString(){return {scripts:scripts.map(textContent=>({textContent}))};}},
    fetch:async(url,options)=>{calls.push({url,options});return request?request(url,options):new Response('synthetic',{headers:{'content-type':'text/html'}});}};
  runInNewContext(source,context);
  return {calls,read:()=>context.__priceCheckerReadPage(1),context};
}

test('source failures distinguish redirects, HTTP errors, response types, state parsing and network failures without website text',async()=>{
  const cases=[
    [{fetch:async()=>({type:'opaqueredirect',get body(){throw Error('must not read redirect');}})},'redirect',0],
    [{fetch:async()=>new Response('synthetic-private',{status:403})},'http_error',403],
    [{fetch:async()=>new Response('synthetic-private',{headers:{'content-type':'application/json'}})},'content_type',200],
    [{scripts:[]},'state_script_missing',200],
    [{scripts:[script(),script()]},'state_script_ambiguous',200],
    [{scripts:['var __NUXT__ = {\n        user: invalid-synthetic-private,\n};']},'user_state',200],
    [{scripts:[script({})]},'customer_missing',200],
    [{scripts:[script({customer:null})]},'customer_null',200],
    [{scripts:[script().replace('        payload:','    payload:')]},'payload_state',200],
    [{scripts:[script(user,{products:[null]})]},'state_shape',200],
    [{fetch:async()=>{throw Error('synthetic-private');}},'request_failed',0],
  ];
  for(const [options,reason,status] of cases) {
    const client=collector(options),result=JSON.parse(JSON.stringify(await client.read()));
    assert.equal(result.source_reason,reason);assert.equal(result.http_status,status);
    assert.equal(result.error,reason==='customer_null'?'login_required':reason==='http_error'?'access_limited':'account_unverified');
    assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
    assert.equal(client.calls.length,1);assert.equal(client.calls[0].options.redirect,'manual');
    // Every fixed source reason survives the VPS allowlist and is linked to the failed page.
    assert.equal(phoneEvent({event_id:'1'.repeat(32),process_id:'2'.repeat(32),seq:1,event:'SOURCE_UNVERIFIED',
      event_at:'2026-11-09T21:30:00Z',source_reason:reason,http_status:status,page:1}).source_reason,reason);
  }
  assert.throws(()=>phoneEvent({event_id:'1'.repeat(32),process_id:'2'.repeat(32),seq:1,event:'SOURCE_UNVERIFIED',
    event_at:'2026-11-09T21:30:00Z',source_reason:'synthetic-private'}));
});

test('source timeout differs from explicit cancellation and does not add a request',async()=>{
  let expire;
  const client=collector({timeout:fn=>{expire=fn;return 0;},fetch:(_url,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(Error('synthetic-private')),{once:true});
  })});
  const pending=client.read();expire();
  const result=await pending;assert.equal(result.error,'interrupted');assert.equal(result.source_reason,'request_timeout');
  assert.equal(client.calls.length,1);assert.equal(client.context.__priceCheckerCancel,undefined);
});

test('source diagnostics do not bypass account checks or leak into successful page payloads',async()=>{
  const client=collector(),result=JSON.parse(JSON.stringify(await client.read()));
  assert.deepEqual(result.user,user);assert.deepEqual(result.payload,{products:[]});
  assert.equal(result.source_reason,undefined);assert.equal(result.http_status,undefined);
});
