import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseWishlistHtml,parseWishlistState,readAllFavorites,LamodaError} from '../src/providers/lamoda/parser.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {LamodaBrowser,wishlistExpression} from '../src/providers/lamoda/browser.js';
import {LamodaLogin} from '../src/providers/lamoda/login.js';

const sku = 'SYNTHETIC001';
const product = (overrides = {}) => ({sku,name:'Куртка',brand:{name:'Пример'},color_family:'синий',seo_tail:'clothes-example-kurtka',
  price_amount:1500,old_price_amount:2000,prices:[{price:'2000'},{price:'1500'},{price:'1400',discount:{type:'onsite_promo'}}],
  price_iso_code:'RUB',is_available:true,is_sellable:true,thumbnail:'/S/Y/SYNTHETIC001.jpg',...overrides});
const state = (products = [product()],{page = 1,limit = 60,favorites = products.map(p => p.sku),customer = {id:42,is_active:true}} = {}) => ({
  user:{customer,wishlist:favorites.map(product_sku => ({product_sku}))},
  payload:{products,pagination:{page,limit,offset:(page-1)*limit,found:favorites.length,pages:Math.ceil(favorites.length/limit)}}});
const html = value => `<html><script>\n  var __NUXT__ = {\n    payload: {\n      state: {\n        user: ${JSON.stringify(value.user)},\n        payload: ${JSON.stringify(value.payload)},\n      },\n    },\n  };\n  LMDA.pageState = __NUXT__;\n</script></html>`;
function store(t) {const root = mkdtempSync(join(tmpdir(),'lamoda-unit-'));const db = new LamodaDatabase(root);t.after(() => {db.close();rmSync(root,{recursive:true,force:true});});return {root,db};}
const parsed = value => parseWishlistState(value.user,value.payload);

test('Lamoda parses the displayed final price without executing embedded scripts or reading cards',() => {
  const result = parseWishlistHtml(html(state()));
  assert.equal(result.account_id,'42');assert.equal(result.items[0].price,140000);assert.equal(result.items[0].original_price,200000);
  assert.equal(result.items[0].sku,sku);assert.equal(result.items[0].availability,'available');
  const source = html(state()).replace('user: {','user: (globalThis.shouldNeverRun=true, {');
  assert.throws(() => parseWishlistHtml(source));assert.equal(globalThis.shouldNeverRun,undefined);
});
test('Lamoda distinguishes explicit logout from an unverified response and rejects a filtered list',() => {
  const guest = state([],{customer:null});assert.throws(() => parsed(guest),error => error.code === 'login_required');
  const unverified = state();delete unverified.user.customer;assert.throws(() => parsed(unverified),error => error.code === 'account_unverified');
  const filtered = state();filtered.payload.pagination.found = 0;assert.throws(() => parsed(filtered),error => error.code === 'incomplete_data');
  assert.equal(parsed(state([product({prices:[],price_amount:null,old_price_amount:null,is_available:false})])).items[0].price,null);
});
test('Lamoda keeps the crossed-out base price for onsite promotions without old_price_amount',() => {
  const discounted = parsed(state([product({old_price_amount:undefined,price_amount:17600,prices:[{price:'17600'},{price:'14960',discount:{type:'onsite_promo'}}]})])).items[0];
  assert.equal(discounted.price,1496000);assert.equal(discounted.original_price,1760000);
  const regular = parsed(state([product({old_price_amount:undefined,price_amount:1350,prices:[{price:'1350'}]})])).items[0];
  assert.equal(regular.original_price,null);assert.equal(regular.price,135000);
});
test('Lamoda traverses every page and refuses missing, repeated, or changed favorites',async () => {
  const favorites = [sku,'SYNTHETIC002','SYNTHETIC003'];let calls = [];
  const read = async page => {calls.push(page);return parsed(state([product({sku:favorites[page-1]})],{page,limit:1,favorites}));};
  const result = await readAllFavorites(read,{expectedAccount:'42'});assert.deepEqual(calls,[1,2,3]);assert.equal(result.items.length,3);
  await assert.rejects(readAllFavorites(read,{expectedAccount:'99'}),error => error.code === 'account_mismatch');
  await assert.rejects(readAllFavorites(async page => page === 1 ? read(1) : read(1)),error => error.code === 'incomplete_data');
  await assert.rejects(readAllFavorites(async page => {
    const result = await read(page);if (page === 2) result.favorites[0] = 'SYNTHETIC999';return result;
  }),error => error.code === 'incomplete_data');
});
test('Lamoda preserves price date through absence, compares returns and keeps the last change on equal prices',t => {
  const {db} = store(t);db.bindAccount('42');
  const record = (p,time) => {const check = db.begin('manual',time);db.record(check,[parsed(state([p])).items[0]],time);};
  record(product(),'2026-10-01T10:00:00Z');record(product({prices:[{price:'1300'}]}),'2026-10-02T10:00:00Z');
  record(product({is_available:false,prices:[{price:'999'}]}),'2026-10-03T10:00:00Z');
  let row = db.dashboard().items[0];assert.equal(row.price,130000);assert.equal(row.price_at,'2026-10-02T10:00:00Z');assert.equal(row.checked_at,'2026-10-03T10:00:00Z');
  record(product({prices:[{price:'1200'}]}),'2026-10-04T10:00:00Z');record(product({prices:[{price:'1200'}]}),'2026-10-05T10:00:00Z');
  row = db.dashboard().items[0];assert.equal(row.last_change.previous_price,130000);assert.equal(row.last_change.delta,-10000);assert.equal(row.last_change.checked_at,'2026-10-04T10:00:00Z');
  assert.equal(db.pending().length,5);assert.equal(db.pending()[0].payload.includes('Lamoda'),false);
  assert.throws(() => db.bindAccount('99'));assert.equal(db.matches('42'),true);
});
test('Lamoda commits membership, observations, and its own outbox atomically',t => {
  const {db} = store(t);const check = db.begin('manual','2026-10-01T10:00:00Z');
  const items = parsed(state()).items;
  assert.throws(() => db.record(check,[...items,{...items[0],sku:undefined}],'2026-10-01T10:00:00Z'));
  assert.equal(db.dashboard().items.length,0);assert.equal(db.pending().length,0);
  db.record(check,items,'2026-10-01T10:00:00Z');assert.equal(db.pending().length,1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='telegram_ozon_outbox'").get().n,0);
});
test('Lamoda errors retain prices and retry on schedule while respecting Retry-After',async t => {
  const root = mkdtempSync(join(tmpdir(),'lamoda-service-unit-'));let clock = Date.parse('2026-10-01T10:00:00Z'),failure = null;const events = [];
  const service = new LamodaService(root,{current:() => clock,logger:event => events.push(event),channel:() => ({available:() => true,
    request:async () => {if (failure) throw failure;return {account_id:'42',items:parsed(state()).items};}})});
  t.after(async () => {await service.close();rmSync(root,{recursive:true,force:true});});
  service.db.bindAccount('42');service.settings({schedule_enabled:true});await service.start();await service.running;
  failure = new LamodaError('access_limited',0,403);await service.start();await service.running;
  assert.equal(service.status().schedule_enabled,true);assert.equal(service.status().action_required,false);
  assert.equal(service.status().next_check,'2026-10-01T10:30:00.000Z');assert.equal(service.db.dashboard().items[0].price,140000);
  failure = new LamodaError('rate_limited',60*60000,429);await service.start();await service.running;
  assert.equal(service.status().next_check,'2026-10-01T11:00:00.000Z');
  clock += 60*60000;failure = new LamodaError('login_required');await service.start();await service.running;
  assert.equal(service.status().action_required,true);assert.equal(service.status().schedule_enabled,true);assert.equal(service.status().next_check,null);
  assert.equal(events.filter(event => event.event === 'collection_error').length,3);
});
test('Lamoda browser transport uses CDP only and saves nothing for a different account',async () => {
  let pageOrigin = 'null';
  const calls = [],browser = new LamodaBrowser({call:async (method,args) => {
    calls.push({method,args});
    if (method === 'Page.navigate') {pageOrigin = 'https://www.lamoda.ru';return {};}
    return {result:{value:args.expression.includes('fetch(') ? {status:200,html:html(state())} : {origin:pageOrigin,ready:'complete'}}};
  }});
  const digest = createHash('sha256').update('lamoda:42').digest('hex');
  assert.equal((await browser.collect(undefined,digest)).items.length,1);
  assert.deepEqual(calls.filter(call => call.method === 'Page.navigate').map(call => call.args.url),['https://lamoda.ru/']);
  const reads = calls.filter(call => call.args.expression?.includes('fetch('));
  assert.equal(reads.length,1);assert.match(reads[0].args.expression,/fetch\('\/wishlist\/\?page=1'/);
  await assert.rejects(browser.collect(undefined,'0'.repeat(64)),error => error.code === 'account_mismatch');
  assert.throws(() => wishlistExpression('1;alert(1)'));assert.throws(() => wishlistExpression(0));
});

test('Lamoda opens only its homepage for interactive login without reading favorites',async () => {
  const calls = [],browser = new LamodaBrowser({call:async (method,args) => {calls.push({method,args});return {};}});
  await browser.openHome();
  assert.deepEqual(calls,[{method:'Page.navigate',args:{url:'https://lamoda.ru/'}}]);
});
test('Lamoda login is bound to its owner and cannot replace a previously connected account',async t => {
  const {root,db} = store(t);db.bindAccount('42');let account = '99';const actions = [];
  const login = new LamodaLogin(root,{db,channel:() => ({available:() => true,request:async action => {
    actions.push(action);return action === 'login_start' ? {port:12345,password:'abcdefgh',key:'a'.repeat(64)} : action === 'login_verify' ? {account_id:account} : {closed:true};
  }})});
  t.after(() => login.close());await login.start('owner');assert.throws(() => login.view('other'));
  await assert.rejects(login.finish('owner'),/другой аккаунт/);assert.equal(db.matches('42'),true);assert.equal(actions.includes('login_finish'),false);
  account = '42';await login.finish('owner');assert.equal(login.status().active,false);assert.equal(actions.includes('login_finish'),true);
});
test('Lamoda cookie restore preserves live profile values and separates first-party partitions',async t => {
  const {root} = store(t),partitionKey = {topLevelSite:'https://lamoda.ru',hasCrossSiteAncestor:false};
  const base = {name:'synthetic-session',domain:'.lamoda.ru',path:'/',secure:true,value:'synthetic-saved'};
  writeFileSync(join(root,'price-checker-session.json'),JSON.stringify([base,{...base,partitionKey},{...base,domain:'.foreign.test'}]));
  const writes = [],browser = new LamodaBrowser({profile:root});browser.call = async (method,args) => {
    if (method === 'Storage.getCookies') return {cookies:[{...base,value:'synthetic-live',expires:-1}]};
    writes.push(args.cookies);return {};
  };
  await browser.seedCookies();assert.equal(writes.length,1);assert.equal(writes[0].length,1);assert.deepEqual(writes[0][0].partitionKey,partitionKey);
});
