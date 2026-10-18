import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OzonLogin} from '../src/providers/ozon/login.js';
import {OzonSession,writePrivateJson} from '../src/providers/ozon/session.js';
import {acquireInstance,AlreadyRunning} from '../src/instance.js';
import {temporary,cleanup} from './helpers.js';
import {connectTestOzon,ozonPage} from './ozon-fixture.js';

async function fixture(t) {
  const root=temporary(t);await connectTestOzon(root);
  writePrivateJson(join(root,'.secrets/ozon/login.json'),{version:1,phone:'+79990000000'});
  const messages=[],actions=[];let closed=0,authorized=0,account=123;
  const channel={login:async (action,data) => {
    actions.push(action);
    if(action==='start') {assert.equal(data.phone,'+79990000000');return {version:2,view:{port:43123,password:'synthet1'}};}
    if(action==='phone') return {version:2,filled:true};
    return {http_status:200,outcome:'json_received',data:ozonPage({account}),user_agent:'Synthetic test browser',
      exported:{cookies:[{name:'session',value:'renewed-synthetic',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,session:true}]}};
  },close:async () => {closed++;}};
  const login=new OzonLogin(root,{publicOrigin:'https://prices.example',browser:() => channel,isBrowserAvailable:() => true,
    notify:async message => messages.push(message),onAuthorized:() => {authorized++;}});
  cleanup(t,() => login.close());
  return {root,login,messages,actions,closed:() => closed,authorized:() => authorized,setAccount:value => {account=value;}};
}

test('owner login notifications persist their cooldown and disclose only the protected page URL',async t => {
  const {root,login,messages}=await fixture(t);
  await login.require();await login.require();
  assert.equal(messages.length,1);assert.match(messages[0],/https:\/\/prices.example\/ozon\/login/);
  assert.doesNotMatch(messages[0],/79990000000|synthet|cookie|password/);
  const restarted=new OzonLogin(root,{publicOrigin:'https://prices.example',notify:async message => messages.push(message)});
  await restarted.require();assert.equal(messages.length,1);await restarted.close();
});

test('the login window belongs to one app session and holds the collector lock until cancellation',async t => {
  const {root,login,closed}=await fixture(t),view=await login.start('owner');
  assert.match(view.websocket_path,/^\/api\/providers\/ozon\/login\/view\?token=/);
  assert.equal(view.phone_hint,'••• 0000');assert.equal(JSON.stringify(view).includes('+79990000000'),false);
  await assert.rejects(acquireInstance(join(root,'.data/ozon/collector.lock')),AlreadyRunning);
  await assert.rejects(login.start('other'));await assert.rejects(login.fillPhone('other'));await assert.rejects(login.finish('other'));
  await assert.rejects(login.cancel('other'));assert.equal(closed(),0);
  let rejection='';login.upgrade({url:view.websocket_path.replace(/token=.*/,'token=wrong')},{end:message => {rejection=message;}},Buffer.alloc(0),'owner');
  assert.match(rejection,/403/);
  await login.cancel('owner');assert.equal(closed(),1);assert.equal(login.status().active,false);
  const release=await acquireInstance(join(root,'.data/ozon/collector.lock'));await release();
});

test('only a confirmed matching account can replace the HTTP jar and close the login browser',async t => {
  const {root,login,actions,closed,authorized,setAccount}=await fixture(t);
  await login.start('owner');await login.fillPhone('owner');
  const path=join(root,'.secrets/ozon/session.json'),before=readFileSync(path);
  setAccount(999);await assert.rejects(login.finish('owner'),/нужный аккаунт/);
  assert.deepEqual(readFileSync(path),before);assert.equal(closed(),0);assert.equal(authorized(),0);
  setAccount(123);assert.deepEqual(await login.finish('owner'),{authorized:true});
  const session=await OzonSession.open(path,'bootstrap=disabled');
  assert.match(await session.header('https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmy%2Ffavorites'),/session=renewed-synthetic/);
  assert.equal(authorized(),1);assert.equal(closed(),1);assert.equal(login.status().active,false);
  assert.deepEqual(actions,['start','phone','finish','finish']);
});

test('a phone-only configuration never exposes an unauthenticated remote view',async t => {
  const {login}=await fixture(t);let response='';
  login.upgrade({url:'/api/providers/ozon/login/view?token=anything'},{end:value => {response=value;}},Buffer.alloc(0),'owner');
  assert.match(response,/403/);assert.equal(login.status().active,false);
});
