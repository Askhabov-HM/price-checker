import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Tracker} from '../src/service.js';
import {TelegramApi, TelegramBot, TelegramError, checkMessage, ozonCheckMessage, createTelegramBot} from '../src/telegram.js';
import {cleanup, item, temporary} from './helpers.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {LamodaDatabase} from '../src/providers/lamoda/database.js';

const ownerId = 670157270;
const publicOrigin = 'https://prices.example';
const update = (id, text, extra = {}) => ({update_id: id, message: {from: {id: ownerId}, chat: {id: ownerId, type: 'private'}, text, ...extra}});
function fakeApi() {
  return {calls: [], fail: null, async call(method, data = {}) {
    this.calls.push({method, data});
    if (method === 'sendMessage' && this.fail) throw this.fail;
    if (method === 'getMe') return {is_bot: true, username: 'fragrance_price_bot'};
    if (method === 'getWebhookInfo') return {url: ''};
    return true;
  }, close() {}};
}
function setup(t, {client = {}, api = fakeApi(), root = temporary(t), ozon,lamoda} = {}) {
  const tracker = new Tracker(root, {client}), logs = [];
  cleanup(t, () => tracker.close());
  const bot = new TelegramBot(tracker, {ownerId, publicOrigin, api, ozon,lamoda, logger: entry => logs.push(entry)});
  cleanup(t, () => bot.close());
  return {tracker, bot, api, root, logs};
}
function finish(db, trigger = 'manual', status = 'success', message = '') {
  const id = db.startCheck(trigger, '2026-10-16T18:00:00+00:00');
  db.updateCheck(id, {status, message, total: 1, completed: 1, finished_at: '2026-10-16T18:01:00+00:00'});
  return id;
}

test('Telegram remains optional and configuration failures never log credentials', t => {
  const {tracker, root} = setup(t), logs = [];
  assert.equal(createTelegramBot(tracker, {}), null);
  const file = join(root, 'token'); writeFileSync(file, '123456:synthetic-token');
  const bot = createTelegramBot(tracker, {PRICE_CHECKER_TELEGRAM_TOKEN_FILE: file, PRICE_CHECKER_TELEGRAM_OWNER_ID: String(ownerId), PRICE_CHECKER_PUBLIC_ORIGIN: publicOrigin}, entry => logs.push(entry));
  assert.ok(bot); cleanup(t, () => bot.close());
  for (const id of ['0', '-5', 'abc', '9007199254740992']) {
    assert.equal(createTelegramBot(tracker, {PRICE_CHECKER_TELEGRAM_TOKEN_FILE: file, PRICE_CHECKER_TELEGRAM_OWNER_ID: id}, entry => logs.push(entry)), null);
  }
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-token|123456/);
  assert.throws(() => new TelegramApi({token: 'invalid-private-token'}), /configuration/);
  assert.throws(() => new TelegramApi({token: '123:abc', proxy: 'socks5h://localhost:1080'}), /configuration/);
});

test('commands require the exact owner and a matching private chat', async t => {
  const {tracker, bot, api} = setup(t);
  let starts = 0; tracker.startRefresh = () => {starts++; return true;};
  let sequence = 1;
  for (const message of [
    {from: {id: 123}}, {chat: {id: ownerId, type: 'group'}}, {chat: {id: 123, type: 'private'}}, {from: {id: ownerId, is_bot: true}}
  ]) await bot.handleUpdate(update(sequence++, '/check_randewoo', message));
  assert.equal(starts, 0); assert.equal(api.calls.length, 0);
  await bot.handleUpdate({update_id: 100, edited_message: update(1, '/check_randewoo').message});
  assert.equal(starts, 0);
  await bot.initializePolling();
  await bot.handleUpdate(update(101, '/check_randewoo@another_bot'));
  assert.equal(starts, 0);
  await bot.handleUpdate(update(102, '/check_randewoo@fragrance_price_bot'));
  assert.equal(starts, 1);
});

test('/check uses the real collection handler, rejects overlap, and notifies on completion', async t => {
  let authorize;
  const authorization = new Promise(resolve => {authorize = resolve;});
  const {tracker, bot, api} = setup(t, {client: {authorizedUser: () => authorization, cart: async () => [], favorites: async () => []}});
  cleanup(t, authorize);
  await bot.handleUpdate(update(1, '/check_randewoo'));
  await bot.handleUpdate(update(2, '/check_randewoo'));
  assert.equal(tracker.db.checks().length, 1);
  assert.equal(tracker.db.checks()[0].trigger, 'telegram');
  assert.match(api.calls[1].data.text, /уже выполняется/);
  authorize({}); await tracker.refreshPromise; await bot.flush();
  const report = api.calls.at(-1).data;
  assert.equal(report.chat_id, ownerId); assert.match(report.text, /^✅.*Randewoo/);
  assert.equal(tracker.db.get('SELECT COUNT(*) AS n FROM telegram_outbox WHERE delivered_at IS NOT NULL').n, 1);
});

test('update offset is stored before dispatch and prevents replay after restart', async t => {
  const {tracker, bot, api, root} = setup(t);
  let starts = 0;
  tracker.startRefresh = () => {assert.equal(tracker.db.setting(bot.offsetKey), 43); starts++; return true;};
  api.fail = new TelegramError('transport');
  await assert.rejects(bot.handleUpdate(update(42, '/check_randewoo')));
  await bot.handleUpdate(update(42, '/check_randewoo'));
  assert.equal(starts, 1);
  await bot.close(); await tracker.close();
  const secondTracker = new Tracker(root, {client: {}}); cleanup(t, () => secondTracker.close());
  secondTracker.startRefresh = () => {starts++; return true;};
  const secondBot = new TelegramBot(secondTracker, {ownerId, publicOrigin, api: fakeApi(), logger: () => {}}); cleanup(t, () => secondBot.close());
  await secondBot.handleUpdate(update(42, '/check_randewoo'));
  assert.equal(starts, 1);
});

test('successful collections notify without invoking or waiting for local backups', async t => {
  const {tracker, bot, api} = setup(t, {client: {authorizedUser: async () => ({}), cart: async () => [], favorites: async () => []}});
  let backupCalls = 0;
  tracker.db.backup = () => {backupCalls++;throw new Error('Synthetic backup failure');};
  await tracker.refreshNow('manual');
  assert.equal(tracker.db.checks()[0].status, 'success');
  await bot.flush(); await bot.flush();
  assert.equal(backupCalls, 0);
  assert.equal(api.calls.length, 1);
  assert.match(api.calls[0].data.text, /^✅.*Randewoo/);
});

test('scheduled, website, CLI and Telegram checks each generate one durable notification', async t => {
  const {tracker, bot, api} = setup(t);
  for (const trigger of ['schedule', 'manual', 'cli', 'telegram']) finish(tracker.db, trigger);
  await bot.flush(); await bot.flush();
  assert.equal(api.calls.length, 4);
  assert.ok(api.calls.every(call => call.data.chat_id === ownerId));
  assert.ok(api.calls.every(call => /Изменений цен нет/.test(call.data.text)));
  assert.ok(api.calls.every(call => call.data.reply_markup.inline_keyboard[0][0].url === publicOrigin + '/cart'));
});

test('an unavailable Telegram preserves reports across process restart and respects Retry-After', async t => {
  const {tracker, bot, api, root, logs} = setup(t);
  const id = finish(tracker.db, 'schedule', 'partial', 'Корзина: сессия истекла');
  api.fail = new TelegramError('request', 429, 30);
  const before = Date.now(); await bot.flush();
  const row = tracker.db.get('SELECT * FROM telegram_outbox WHERE check_id=?', id);
  assert.equal(row.attempts, 1); assert.equal(row.delivered_at, null); assert.ok(row.next_attempt_ms >= before + 30000);
  await bot.flush(); assert.equal(api.calls.length, 1);
  assert.equal(logs.at(-1).code, 429);
  tracker.db.run('UPDATE telegram_outbox SET next_attempt_ms=0');
  await bot.close(); await tracker.close();
  const restarted = new Tracker(root, {client: {}}); cleanup(t, () => restarted.close());
  const workingApi = fakeApi(), resumed = new TelegramBot(restarted, {ownerId, publicOrigin, api: workingApi, logger: () => {}});
  cleanup(t, () => resumed.close());
  await resumed.flush(); await resumed.flush();
  assert.equal(workingApi.calls.length, 1); assert.match(workingApi.calls[0].data.text, /Часть данных не удалось получить/);
  assert.equal(workingApi.calls[0].data.entities.find(e => e.type === 'custom_emoji').custom_emoji_id, '5382276449241703317');
});

test('first activation skips historical checks but recovers an interrupted subsequent collection', async t => {
  const root = temporary(t), tracker = new Tracker(root, {client: {}}); cleanup(t, () => tracker.close());
  finish(tracker.db);
  const api = fakeApi(), bot = new TelegramBot(tracker, {ownerId, publicOrigin, api, logger: () => {}}); cleanup(t, () => bot.close());
  await bot.flush(); assert.equal(api.calls.length, 0);
  tracker.db.startCheck('manual');
  await bot.close(); await tracker.close();
  const restarted = new Tracker(root, {client: {}}); cleanup(t, () => restarted.close());
  const resumed = new TelegramBot(restarted, {ownerId, publicOrigin, api, logger: () => {}}); cleanup(t, () => resumed.close());
  await resumed.flush(); assert.match(api.calls[0].data.text, /Проверка прервана/);
});

test('reports compare the last observation in each context and fit Telegram without broken Unicode', t => {
  const {tracker} = setup(t), db = tracker.db, variant = db.variant(item());
  db.observation(variant, item({price_kopecks: 20000}), 'public');
  db.observation(variant, item({price_kopecks: 18000}), 'cart');
  const id = finish(db, 'manual', 'partial', '🙂'.repeat(4000));
  db.observation(variant, item({price_kopecks: 16000}), 'public', id);
  db.observation(variant, item({price_kopecks: 15000}), 'public', id);
  db.observation(variant, item({price_kopecks: 18000}), 'cart', id);
  const report = checkMessage(db, db.checks(1)[0]);
  assert.match(report, /Снижений: 1/); assert.match(report, /Повышений: 0/);
  assert.doesNotMatch(report, /Brand|Fragrance|₽|🙂/);
  assert.match(report, /21:01 МСК/); assert.ok(report.length <= 4000); assert.doesNotMatch(report, /[\uD800-\uDBFF]$/);
});

test('/status reports progress, schedule and an expired Randewoo session', async t => {
  const {tracker, bot, api} = setup(t);
  tracker.db.setSetting('auth_status', 'expired');
  await bot.handleUpdate(update(1, '/status'));
  assert.match(api.calls[0].data.text, /Следующая проверка/);
  assert.match(api.calls[0].data.text, /Randewoo требует внимания/);
  assert.doesNotMatch(api.calls[0].data.text, /csrf|cookie|token/i);
});

function setupOzon(t) {
  const root = temporary(t), db = new OzonDatabase(root);
  cleanup(t, () => db.close());
  const ozon = {db, running: false};
  return {...setup(t, {root, ozon}), ozon};
}
const favorite = (sku, price, availability = 'available', original = null) => ({external_id: sku,
  url: `https://www.ozon.ru/product/${sku}/`, title: `Private product ${sku}`, availability,
  listed_price_kopecks: price, original_price_kopecks: original});
function finishOzon(ozon, products, status = 'success', message = '') {
  const stamp = new Date().toISOString(), id = ozon.db.begin('manual', stamp);
  if (products) ozon.db.recordFavorites(id, products, stamp);
  ozon.db.finish(id, status, message, stamp);
  return id;
}

test('many Randewoo changes remain a small summary and carry the correct emoji entity and site button', async t => {
  const {tracker, bot, api} = setup(t), db = tracker.db;
  const id = finish(db);
  for (let i = 0; i < 250; i++) {
    const product = item({url: `https://randewoo.ru/product/private-${i}`, sku: String(i), name: `Private product ${i}`});
    const variant = db.variant(product);
    db.observation(variant, {...product, price_kopecks: 10000}, 'public');
    db.observation(variant, {...product, price_kopecks: i < 200 ? 9000 : 11000}, 'public', id);
  }
  await bot.flush();
  const payload = api.calls[0].data;
  assert.match(payload.text, /Снижений: 200/);
  assert.match(payload.text, /Повышений: 50/);
  assert.doesNotMatch(payload.text, /Private|private-|₽|Ещё/);
  assert.ok(payload.text.length < 250);
  const entity = payload.entities.find(e => e.type === 'custom_emoji');
  assert.equal(entity.custom_emoji_id, '5382276449241703317');
  assert.equal(payload.text.slice(entity.offset, entity.offset + entity.length), '🌸');
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url, publicOrigin + '/cart');
});

test('Ozon counts only fresh PRICE changes and resumes comparison with the price before unavailability', async t => {
  const {bot, api, ozon} = setupOzon(t);
  finishOzon(ozon, [favorite('123', 10000), favorite('456', 20000), favorite('789', 30000)]);
  await bot.flush(); api.calls.length = 0;
  finishOzon(ozon, [favorite('123', 9000), favorite('456', 23000), favorite('789', null, 'out_of_stock'),
    favorite('999', 5000), favorite('1000', null)]);
  await bot.flush();
  let payload = api.calls.at(-1).data;
  assert.match(payload.text, /Снижений: 1/); assert.match(payload.text, /Повышений: 1/);
  assert.doesNotMatch(payload.text, /Private|123|456|налич|новый|₽/);
  const entity = payload.entities.find(e => e.type === 'custom_emoji');
  assert.equal(entity.custom_emoji_id, '5463148170869482726');
  assert.equal(payload.text.slice(entity.offset, entity.offset + entity.length), '😎');
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url, publicOrigin + '/ozon');
  finishOzon(ozon, [favorite('123', 9000, 'available', 15000), favorite('456', 23000), favorite('789', 27000)]);
  await bot.flush(); payload = api.calls.at(-1).data;
  assert.match(payload.text, /Снижений: 1/); assert.match(payload.text, /Повышений: 0/);
  finishOzon(ozon, [favorite('123', 9000, 'available', 19000), favorite('456', 23000), favorite('789', 27000)]);
  assert.match(ozonCheckMessage(ozon.db, ozon.db.checks()[0]), /Изменений цен нет/);
});

test('every failure is reported and recovery is announced once per store', async t => {
  const {tracker, bot, api, ozon} = setupOzon(t);
  finish(tracker.db, 'manual', 'error', 'Synthetic failure A'); await bot.flush();
  finish(tracker.db, 'manual', 'error', 'Synthetic failure A'); await bot.flush();
  assert.equal(api.calls.length, 2);
  finish(tracker.db, 'manual', 'error', 'Synthetic failure B'); await bot.flush();
  assert.equal(api.calls.length, 3);
  finishOzon(ozon, []); await bot.flush();
  assert.doesNotMatch(api.calls.at(-1).data.text, /снова работает/);
  finish(tracker.db); await bot.flush();
  assert.match(api.calls.at(-1).data.text, /Проверка снова работает/);
  finish(tracker.db); await bot.flush();
  assert.doesNotMatch(api.calls.at(-1).data.text, /снова работает/);
  assert.ok(api.calls.every(call => !/Synthetic failure/.test(call.data.text)));
});

test('each store reports identical errors for separate checks and does not resend a delivered check after restart',async t => {
  for (const store of ['randewoo','ozon','lamoda']) await t.test(store,async t => {
    const root = temporary(t);
    const ozon = store === 'ozon' ? {db:new OzonDatabase(root),running:false} : undefined;
    const lamoda = store === 'lamoda' ? {db:new LamodaDatabase(root)} : undefined;
    if (ozon) cleanup(t,() => ozon.db.close());
    if (lamoda) cleanup(t,() => lamoda.db.close());
    const {tracker,bot,api} = setup(t,{root,ozon,lamoda});
    const complete = () => {
      const message = 'Synthetic private repeated error';
      if (ozon) return finishOzon(ozon,null,'error',message);
      if (lamoda) {
        const stamp = new Date().toISOString(),check = lamoda.db.begin('schedule',stamp);
        lamoda.db.failure(check,message,stamp);return check;
      }
      return finish(tracker.db,'schedule','error',message);
    };
    for (let i = 0; i < 3; i++) complete();
    await bot.flush();await bot.flush();
    assert.equal(api.calls.length,3);
    assert.ok(api.calls.every(call => call.data.text.includes('Не удалось выполнить проверку.')));
    assert.ok(api.calls.every(call => !call.data.text.includes('Synthetic private')));
    await bot.close();
    const workingApi = fakeApi(),resumed = new TelegramBot(tracker,{ownerId,publicOrigin,api:workingApi,ozon,lamoda,logger:() => {}});
    cleanup(t,() => resumed.close());
    await resumed.flush();assert.equal(workingApi.calls.length,0);
    complete();await resumed.flush();await resumed.flush();
    assert.equal(workingApi.calls.length,1);
  });
});

test('partial reports preserve separate counters and do not expose the underlying error details', async t => {
  const {tracker, bot, api} = setup(t), db = tracker.db;
  const variant = db.variant(item()); db.observation(variant, item({price_kopecks: 10000}), 'public');
  const id = finish(db, 'manual', 'partial', 'Private internal response');
  db.observation(variant, item({price_kopecks: 9000}), 'public', id);
  await bot.flush();
  assert.match(api.calls[0].data.text, /^⚠️/);
  assert.match(api.calls[0].data.text, /Снижений: 1/);
  assert.match(api.calls[0].data.text, /Повышений: 0/);
  assert.doesNotMatch(api.calls[0].data.text, /Private internal response|Fragrance/);
});

test('confirmed Ozon login loss has the protected login button and the callback does not duplicate the report', async t => {
  const {bot, api, ozon} = setupOzon(t);
  finishOzon(ozon, null, 'error', 'Нужно обновить вход в Ozon.');
  await bot.notifyOzonLogin(); await bot.notifyOzonLogin(); await bot.flush();
  assert.equal(api.calls.length, 1);
  const payload = api.calls[0].data;
  assert.match(payload.text, /^🔐.*Ozon/);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url, publicOrigin + '/ozon/login');
  assert.doesNotMatch(payload.text, /Снижений|Повышений/);
  finishOzon(ozon,null,'error','Нужно обновить вход в Ozon.');
  await bot.notifyOzonLogin();await bot.notifyOzonLogin();await bot.flush();
  assert.equal(api.calls.length,2);
});

test('a saved-price-only unavailable Randewoo observation never counts as a price change', t => {
  const {tracker} = setup(t), db = tracker.db, variant = db.variant(item());
  db.observation(variant, item({price_kopecks: 10000}), 'public');
  const id = finish(db);
  db.observation(variant, item({price_kopecks: 9000, in_stock: false}), 'public', id);
  assert.match(checkMessage(db, db.checks()[0]), /Изменений цен нет/);
});

test('old pending text reports are upgraded durably and delayed delivery preserves the collection timestamp', async t => {
  const {tracker, bot, api} = setup(t), id = finish(tracker.db);
  tracker.db.run('INSERT INTO telegram_outbox(check_id,owner_id,text) VALUES(?,?,?)', id, ownerId, 'Private obsolete product details');
  tracker.db.setSetting(bot.cursorKey, id);
  await bot.flush();
  const payload = api.calls[0].data;
  assert.match(payload.text, /16.10, 21:01 МСК/);
  assert.match(payload.text, /Отчёт доставлен с задержкой/);
  assert.doesNotMatch(payload.text, /Private obsolete/);
  const stored = JSON.parse(tracker.db.get('SELECT text FROM telegram_outbox WHERE check_id=?', id).text);
  assert.equal(stored.store, 'randewoo');
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url, publicOrigin + '/cart');
  assert.ok(payload.entities.some(e => e.custom_emoji_id === '5382276449241703317'));
  const fresh = finish(tracker.db);
  tracker.db.updateCheck(fresh, {finished_at: new Date().toISOString()});
  await bot.flush();
  assert.doesNotMatch(api.calls.at(-1).data.text, /доставлен с задержкой/);
});

test('each report opens its store route, including failures and login requests', async t => {
  for (const store of ['randewoo', 'ozon']) {
    for (const status of ['success', 'partial', 'error', 'interrupted', 'login']) {
      await t.test(`${store}: ${status}`, async t => {
        const {tracker, bot, api, ozon} = setupOzon(t);
        const login = store === 'ozon' ? 'Нужно обновить вход в Ozon.' : 'Сессия истекла: обновите вход в Randewoo';
        const message = status === 'login' ? login : 'Synthetic collection result';
        const checkStatus = status === 'login' ? 'error' : status;
        if (store === 'ozon') finishOzon(ozon, null, checkStatus, message);
        else finish(tracker.db, 'manual', checkStatus, message);
        await bot.flush();
        assert.equal(api.calls.length, 1);
        const button = api.calls[0].data.reply_markup.inline_keyboard[0][0];
        const path = store === 'randewoo' ? '/cart' : status === 'login' ? '/ozon/login' : '/ozon';
        assert.equal(button.url, publicOrigin + path);
      });
    }
  }
});

test('service commands have a site button while ordinary Codex replies remain ordinary text', async t => {
  const {bot, api} = setup(t);
  for (const [i, command] of ['/start', '/help', '/check', '/status'].entries()) {
    await bot.handleUpdate(update(i + 1, command));
    assert.equal(api.calls.at(-1).data.reply_markup.inline_keyboard[0][0].url, publicOrigin);
  }
  await bot.send('Ordinary reply', {service: false});
  assert.equal(api.calls.at(-1).data.reply_markup, undefined);
});

test('site configuration rejects missing origins, credentials and off-origin URL components', t => {
  const {tracker} = setup(t);
  for (const origin of [undefined, 'javascript:bad', 'https://user:secret@prices.example',
    'https://prices.example/path', 'https://prices.example?secret=1', 'https://prices.example#fragment']) {
    assert.throws(() => new TelegramBot(tracker, {ownerId, api: fakeApi(), publicOrigin: origin}), /configuration/);
  }
});

function transportFixture({status = 200, result = [], code = 0, pending = false, parameters} = {}) {
  const calls = [];
  const api = new TelegramApi({token: '123456:synthetic-private-token', proxy: 'http://127.0.0.1:17890', spawnProcess: (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', null));
    let config = '';
    child.stdin.on('data', chunk => {config += chunk;});
    child.stdin.on('finish', () => {
      calls.push({command, args, options, config});
      if (pending) return;
      queueMicrotask(() => {
        child.stderr.write('private-token secret-curl-error');
        child.stdout.write(JSON.stringify({ok: status === 200, result, error_code: status, description: 'synthetic-private-token', parameters}) + '\nPRICE_CHECKER_STATUS:' + status);
        child.emit('close', code);
      });
    });
    return child;
  }});
  return {api, calls};
}

test('Telegram uses its own proxy and passes token and payload only through stdin', async () => {
  const {api, calls} = transportFixture({result: {message_id: 1}});
  assert.equal((await api.call('sendMessage', {chat_id: ownerId, text: 'Цена: 100 ₽'})).message_id, 1);
  assert.deepEqual(calls[0].args, ['-q', '--config', '-']); assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].config, /proxy = "http:\/\/127.0.0.1:17890"/);
  assert.match(calls[0].config, /synthetic-private-token/);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /token|Цена/);
  api.close();
});

test('API errors redact Telegram descriptions and retain only safe retry information', async () => {
  const {api} = transportFixture({status: 429, parameters: {retry_after: 7}});
  await assert.rejects(api.call('sendMessage'), error => {
    assert.equal(error.code, 429); assert.equal(error.retryAfter, 7);
    assert.doesNotMatch(error.message, /private-token|secret-curl/); return true;
  });
  api.close();
});

test('shutdown cancels long polling and does not wait for the timeout', async () => {
  const {api} = transportFixture({pending: true});
  const request = api.call('getUpdates', {timeout: 25});
  api.close(); await assert.rejects(request, /stopped/);
  assert.equal(api.children.size, 0);
});


test('reports end with the current store next check in Moscow time, after delay notices', async t => {
  const {bot, tracker, api} = setup(t);
  tracker.status = () => ({next_check: '2026-10-21T21:05:00Z'});
  bot.ozon = {status: () => ({next_check: '2026-10-21T07:30:00Z'})};
  const payload = {format: 'price-checker-telegram-v1', text: 'Report', finishedAt: '2020-01-01T00:00:00Z'};
  await bot.send({...payload, store: 'randewoo'});
  assert.match(api.calls.at(-1).data.text, /с задержкой\.\n\nСледующая проверка: 00:05$/);
  await bot.send({...payload, store: 'ozon'});
  assert.match(api.calls.at(-1).data.text, /Следующая проверка: 10:30$/);
  bot.ozon.status = () => ({next_check: null});
  await bot.send({...payload, store: 'ozon'});
  assert.match(api.calls.at(-1).data.text, /Следующая проверка: не запланирована$/);
  bot.ozon.status = () => ({next_check: '2026-10-21T07:30:00Z', action_required: true});
  await bot.send({...payload, store: 'ozon'});
  assert.match(api.calls.at(-1).data.text, /Следующая проверка: требуется вход$/);
  await bot.send('Chat reply', {service: false});
  assert.equal(api.calls.at(-1).data.text, 'Chat reply');
});
