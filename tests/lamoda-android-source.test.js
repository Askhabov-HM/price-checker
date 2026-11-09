import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {phoneEvent} from '../src/providers/lamoda/mobile-telemetry.js';

const source=readFileSync(new URL('../apps/lamoda-android/app/src/main/assets/collector.js',import.meta.url),'utf8');
const user={customer:{id:42,is_active:true},wishlist:[]};
const payload=page=>({products:[],pagination:{page,found:0,limit:60,offset:0,pages:1}});
const script=(account=user,data=payload(1))=>'var __NUXT__ = {\n        user: '+JSON.stringify(account)+',\n        payload: '+JSON.stringify(data)+',\n};';
function collector({scripts=[script()],href='https://www.lamoda.ru/wishlist/?page=1',ready='complete'}={}) {
  let requests=0;
  const context={URL,TextEncoder,location:{origin:new URL(href).origin,href},document:{readyState:ready,scripts:scripts.map(textContent=>({textContent}))},
    fetch:()=>{requests++;throw Error('A DOM reader must not request another document');}};
  runInNewContext(source,context);
  return {context,requests:()=>requests,read:(page=1)=>JSON.parse(JSON.stringify(context.__priceCheckerReadPage(page)))};
}

test('a Servicepipe challenge waits for normal document navigation without fetching, logging out or using old runtime state',()=>{
  const client=collector({scripts:['function get_cookie_spsn(){return "synthetic-private";}']});
  client.context.__NUXT__={payload:{state:{user,payload:payload(1)}}};
  assert.deepEqual(client.read(),{pending:true,source_reason:'state_script_missing'});assert.equal(client.requests(),0);
  // Simulate the real WebView replacing the challenge document after its own scripts finish.
  client.context.document={readyState:'complete',scripts:[{textContent:script()}]};
  const result=client.read();assert.deepEqual(result.user,user);assert.deepEqual(result.payload,payload(1));
  assert.equal(client.requests(),0);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
});

test('only the requested complete wishlist page can supply a snapshot',()=>{
  for(const href of ['https://www.lamoda.ru/wishlist/?page=2','https://www.lamoda.ru/wishlist/?page=1&page=1',
    'https://www.lamoda.ru/wishlist/?page=1&filter=synthetic','https://www.lamoda.ru/customer/account/']) {
    assert.deepEqual(collector({href}).read(),{pending:true,source_reason:'page_navigation'});
  }
  assert.deepEqual(collector({ready:'loading'}).read(),{pending:true});
  assert.equal(collector({href:'https://other.example/wishlist/?page=1'}).read().error,'invalid_data');
  assert.equal(collector().read(0).error,'invalid_data');assert.equal(collector().read(1001).error,'invalid_data');
  assert.deepEqual(collector({href:'https://www.lamoda.ru/wishlist/'}).read().user,user);
  assert.equal(collector({href:'https://www.lamoda.ru/wishlist/?page=2',scripts:[script(user,payload(1))]}).read(2).error,'incomplete_data');
  const second=collector({href:'https://www.lamoda.ru/wishlist/?page=2',scripts:[script(user,payload(2))]}).read(2);
  assert.equal(second.payload.pagination.page,2);
});

test('document parsing distinguishes a malformed response from confirmed logout without recording website text',()=>{
  const cases=[
    [[script(),script()],'state_script_ambiguous'],
    [['var __NUXT__ = {\n        user: invalid-synthetic-private,\n};'],'user_state'],
    [[script({})],'customer_missing'],
    [[script({customer:null})],'customer_null'],
    [[script().replace('        payload:','    payload:')],'payload_state'],
    [[script(user,{...payload(1),products:[null]})],'state_shape'],
  ];
  for(const [scripts,reason] of cases) {
    const client=collector({scripts}),result=client.read();
    assert.equal(result.source_reason,reason);assert.equal(result.error,reason==='customer_null'?'login_required':'account_unverified');
    assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);assert.equal(client.requests(),0);
    assert.equal(phoneEvent({event_id:'1'.repeat(32),process_id:'2'.repeat(32),seq:1,event:'SOURCE_UNVERIFIED',
      event_at:'2026-11-09T21:30:00Z',source_reason:reason,page:1}).source_reason,reason);
  }
});

test('the DOM reader parses JSON members without executing site code and strips unrelated profile and price metadata',()=>{
  const data={...payload(1),private:'synthetic-private',products:[{sku:'SYNTHETIC01',prices:[{price:'100',profile:'synthetic-private'}]}]};
  const client=collector({scripts:[script({...user,email:'synthetic-private'},data)+'\nglobalThis.executed=true;']});
  client.context.executed=false;
  const result=client.read();assert.equal(client.context.executed,false);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
  assert.deepEqual(result.payload.products[0].prices,[{price:'100'}]);assert.equal(result.source_reason,undefined);
});
