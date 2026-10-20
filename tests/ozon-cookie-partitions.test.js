import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {importOzonConnection} from '../src/providers/ozon/connection.js';
import {OzonSession,OZON_COOKIE_PARTITION,writePrivateJson} from '../src/providers/ozon/session.js';
import {browserCookieParams,browserCookieSeed} from '../src/providers/ozon/browser-refresh.js';
import {OzonLogin} from '../src/providers/ozon/login.js';
import {temporary} from './helpers.js';
import {connectTestOzon,ozonPage} from './ozon-fixture.js';

const url = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmy%2Ffavorites';
const input = {request:{method:'GET',url,headers:{'user-agent':'Synthetic test browser'}},reference:{account_id:'123'}};
const ordinary = {name:'session',value:'ordinary-synthetic',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,session:true};
const partitioned = {...ordinary,value:'partitioned-synthetic',partitionKey:{...OZON_COOKIE_PARTITION}};
const load = root => OzonSession.open(join(root,'.secrets/ozon/session.json'),'bootstrap=disabled');
const importCookies = (root,cookies) => importOzonConnection(root,input,{cookies});

test('ordinary and first-party partitioned cookies with the same identity survive import and restart independently',async t => {
  const root = temporary(t);
  await importCookies(root,[partitioned,ordinary]);
  const session = await load(root),header = await session.header(url);
  assert.deepEqual(new Set(header.split('; ')),new Set(['session=ordinary-synthetic','session=partitioned-synthetic']));
  const cookies = await session.browserCookies();assert.equal(cookies.length,2);
  assert.equal(cookies.find(cookie => !cookie.partitionKey).value,ordinary.value);
  assert.deepEqual(cookies.find(cookie => cookie.partitionKey).partitionKey,OZON_COOKIE_PARTITION);
  const params = browserCookieParams(cookies);
  assert.equal(params.filter(cookie => cookie.partitionKey).length,1);
  assert.equal(params.find(cookie => cookie.partitionKey).value,partitioned.value);
  const saved = JSON.parse(readFileSync(join(root,'.secrets/ozon/session.json'),'utf8'));
  assert.equal(saved.jar.cookies.length,1);assert.equal(saved.partitionedJar.cookies.length,1);
});

test('updating or deleting a partitioned cookie cannot replace the ordinary cookie with the same name',async t => {
  const root = temporary(t);await importCookies(root,[ordinary,partitioned]);
  const session = await load(root);
  await session.absorb(new Headers({'Set-Cookie':'session=updated-partition; Domain=.ozon.ru; Path=/; Secure; Partitioned'}),url);
  let cookies = await (await load(root)).browserCookies();
  assert.equal(cookies.find(cookie => !cookie.partitionKey).value,ordinary.value);
  assert.equal(cookies.find(cookie => cookie.partitionKey).value,'updated-partition');
  await session.absorb(new Headers({'Set-Cookie':'session=; Domain=.ozon.ru; Path=/; Secure; Partitioned; Max-Age=0'}),url);
  cookies = await (await load(root)).browserCookies();
  assert.equal(cookies.length,1);assert.equal(cookies[0].value,ordinary.value);
});

test('a foreign partition is excluded and a duplicate within one partition still fails without replacing saved login',async t => {
  const root = temporary(t);
  await importCookies(root,[ordinary,{...partitioned,partitionKey:{topLevelSite:'https://other.test',hasCrossSiteAncestor:false}},
    {...partitioned,partitionKey:{...OZON_COOKIE_PARTITION,hasCrossSiteAncestor:true}}]);
  assert.equal((await (await load(root)).browserCookies()).length,1);
  const path = join(root,'.secrets/ozon/session.json'),before = readFileSync(path);
  for (const cookies of [[ordinary,{...ordinary,value:'conflicting'}],[partitioned,{...partitioned,value:'conflicting'}]]) {
    await assert.rejects(importCookies(root,cookies),/Неоднозначный/);
    assert.deepEqual(readFileSync(path),before);
  }
  await assert.rejects(importCookies(root,[ordinary,{...partitioned,secure:false}]),/cookies/);
  await assert.rejects(importCookies(root,[ordinary,{...partitioned,partitionKeyOpaque:true}]),/область/);
  assert.deepEqual(readFileSync(path),before);
});

test('partitioned cookies retain absolute expiry without expiring ordinary session cookies',async t => {
  const root = temporary(t);let now = Date.now();
  await importOzonConnection(root,input,{cookies:[ordinary,{...partitioned,session:false,expires:(now+10000)/1000}]},{current:() => now});
  now += 11000;
  const session = await OzonSession.open(join(root,'.secrets/ozon/session.json'),'bootstrap=disabled',{current:() => now});
  assert.equal(await session.header(url),'session=ordinary-synthetic');
});

test('old sessions without a partitioned jar remain readable',async t => {
  const root = temporary(t);await importCookies(root,[ordinary]);
  const path = join(root,'.secrets/ozon/session.json'),old = JSON.parse(readFileSync(path,'utf8'));
  delete old.partitionedJar;writePrivateJson(path,old);
  assert.equal(await (await load(root)).header(url),'session=ordinary-synthetic');
});

test('profile seeding distinguishes ordinary and partitioned cookies and rejects foreign partition parameters',() => {
  const cookies = [{...ordinary,domain:'ozon.ru',hostOnly:false},{...partitioned,domain:'ozon.ru',hostOnly:false}];
  const existing = [{...partitioned,value:'fresh-profile-synthetic'}];
  const seed = browserCookieSeed(cookies,existing);
  assert.equal(seed.length,1);assert.equal(seed[0].value,ordinary.value);assert.equal(seed[0].partitionKey,undefined);
  assert.throws(() => browserCookieParams([{...cookies[1],partitionKey:{topLevelSite:'https://other.test',hasCrossSiteAncestor:false}}]));
  assert.throws(() => browserCookieParams([{...cookies[1],partitionKey:{...OZON_COOKIE_PARTITION,hasCrossSiteAncestor:true}}]));
});

test('confirmed owner login saves both cookie contexts and closes the interactive browser',async t => {
  const root = temporary(t);await connectTestOzon(root);
  writePrivateJson(join(root,'.secrets/ozon/login.json'),{phone:'+79990000000'});
  let closed = 0,authorized = 0;
  const login = new OzonLogin(root,{isBrowserAvailable:() => true,publicOrigin:'https://prices.example',
    onAuthorized:() => {authorized++;},browser:() => ({close:async () => {closed++;},login:async action => action === 'start'
      ? {view:{port:43123,password:'synthet1'}}
      : {http_status:200,outcome:'json_received',data:ozonPage(),user_agent:'Synthetic test browser',exported:{cookies:[ordinary,partitioned]}}})});
  t.after(() => login.close());
  await login.start('owner');assert.deepEqual(await login.finish('owner'),{authorized:true});
  assert.equal(closed,1);assert.equal(authorized,1);assert.equal(login.status().active,false);
  const cookies = await (await load(root)).browserCookies();assert.equal(cookies.length,2);
});
