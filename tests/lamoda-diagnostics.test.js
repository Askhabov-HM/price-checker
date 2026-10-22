import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {LamodaDiagnostics,diagnosticHeaders,diagnosticUrl} from '../src/providers/lamoda/diagnostics.js';

function recorder(t,options = {}) {
  const root = mkdtempSync(join(tmpdir(),'lamoda-diagnostics-unit-')),calls = [];
  const capture = new LamodaDiagnostics(async (method,params,session) => {
    calls.push({method,params,session});
    if (method === 'Network.getResponseBody') return {body:'<html>synthetic protection response</html>',base64Encoded:false};
    if (method === 'Runtime.evaluate') return {result:{value:{url:'https://www.lamoda.ru/',title:'Synthetic',ready:'complete'}}};
    return {};
  },{directory:root,...options});
  t.after(() => {capture.close();rmSync(root,{recursive:true,force:true});});
  return {capture,calls,root,events:() => readFileSync(capture.path,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))};
}

test('Lamoda diagnostic metadata excludes credentials, query strings, and private response headers',() => {
  assert.equal(diagnosticUrl('https://synthetic:private@www.lamoda.ru/path?token=private#fragment'),'https://www.lamoda.ru/path');
  assert.equal(diagnosticUrl('blob:https://www.lamoda.ru/synthetic?token=private'),'blob:https://www.lamoda.ru/synthetic');
  assert.equal(diagnosticUrl('data:text/html,private'),'data:');
  assert.deepEqual(diagnosticHeaders({'Set-Cookie':'synthetic-private','Authorization':'synthetic-private','X-SP-CRID':'synthetic-id','Content-Type':'text/html'}),
    {'x-sp-crid':'synthetic-id','content-type':'text/html'});
});

test('Lamoda diagnostics observes worker errors and protection responses without navigating or issuing page requests',async t => {
  const {capture,calls,events} = recorder(t);await capture.start('page');
  capture.event({method:'Target.attachedToTarget',params:{sessionId:'worker',targetInfo:{type:'worker',url:'blob:https://www.lamoda.ru/worker'}}});
  await setImmediate();
  capture.event({sessionId:'worker',method:'Runtime.exceptionThrown',params:{exceptionDetails:{text:'Synthetic worker failure',lineNumber:7,exception:{description:'Synthetic exception'}}}});
  capture.event({sessionId:'page',method:'Network.responseReceived',params:{requestId:'document',type:'Document',response:{url:'https://www.lamoda.ru/?private=1',status:403,headers:{'X-SP-CRID':'synthetic-request','Set-Cookie':'synthetic-private'}}}});
  capture.event({sessionId:'page',method:'Network.loadingFinished',params:{requestId:'document',encodedDataLength:4000}});
  await setImmediate();await capture.finish();
  const response = events().find(item => item.event === 'response');
  assert.equal(response.status,403);assert.deepEqual(response.headers,{'x-sp-crid':'synthetic-request'});
  assert.equal(response.url,'https://www.lamoda.ru/');
  assert.equal(events().find(item => item.event === 'js_exception').session_id,'worker');
  assert.ok(calls.some(call => call.method === 'Runtime.enable' && call.session === 'worker'));
  assert.ok(readFileSync(join(capture.directory,'document-1.html'),'utf8').includes('synthetic protection response'));
  assert.equal(capture.counts.js_exceptions,1);
  assert.equal(calls.some(call => call.method === 'Page.navigate' || call.method === 'Network.loadNetworkResource'),false);
  if (process.platform !== 'win32') assert.equal(statSync(capture.path).mode & 0o777,0o600);
});

test('Lamoda diagnostic size and filesystem failures stay bounded and do not fail the browser',t => {
  const {capture,events,root} = recorder(t,{maxBytes:500});
  for (let index = 0; index < 100; index++) capture.write('synthetic',{text:'x'.repeat(100)});
  assert.ok(statSync(capture.path).size <= 500);assert.equal(capture.truncated,true);assert.ok(events().length > 0);
  rmSync(root,{recursive:true,force:true});
  assert.doesNotThrow(() => capture.close());
});

test('Lamoda diagnostics does not save oversized document bodies',async t => {
  const {capture,events} = recorder(t);await capture.start('page');
  capture.event({method:'Network.responseReceived',params:{requestId:'large',type:'Document',response:{url:'https://www.lamoda.ru/',status:200}}});
  capture.event({method:'Network.loadingFinished',params:{requestId:'large',encodedDataLength:300*1024}});
  await setImmediate();capture.close();
  assert.equal(events().some(item => item.event === 'document_saved'),false);
  assert.equal(readdirSync(capture.directory).some(name => name.endsWith('.html')),false);
});
