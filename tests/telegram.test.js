import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Tracker} from '../src/service.js';
import {TelegramApi, TelegramBot, TelegramError, checkMessage, createTelegramBot} from '../src/telegram.js';
import {cleanup, item, temporary} from './helpers.js';

const ownerId = 670157270;
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
function setup(t, {client = {}, api = fakeApi(), root = temporary(t)} = {}) {
  const tracker = new Tracker(root, {client}), logs = [];
  cleanup(t, () => tracker.close());
  const bot = new TelegramBot(tracker, {ownerId, api, logger: entry => logs.push(entry)});
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
  const bot = createTelegramBot(tracker, {PRICE_CHECKER_TELEGRAM_TOKEN_FILE: file, PRICE_CHECKER_TELEGRAM_OWNER_ID: String(ownerId)}, entry => logs.push(entry));
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
  ]) await bot.handleUpdate(update(sequence++, '/check', message));
  assert.equal(starts, 0); assert.equal(api.calls.length, 0);
  await bot.handleUpdate({update_id: 100, edited_message: update(1, '/check').message});
  assert.equal(starts, 0);
  await bot.initializePolling();
  await bot.handleUpdate(update(101, '/check@another_bot'));
  assert.equal(starts, 0);
  await bot.handleUpdate(update(102, '/check@fragrance_price_bot'));
  assert.equal(starts, 1);
});

test('/check uses the real collection handler, rejects overlap, and notifies on completion', async t => {
  let authorize;
  const authorization = new Promise(resolve => {authorize = resolve;});
  const {tracker, bot, api} = setup(t, {client: {authorizedUser: () => authorization, cart: async () => [], favorites: async () => []}});
  cleanup(t, authorize);
  await bot.handleUpdate(update(1, '/check'));
  await bot.handleUpdate(update(2, '/check'));
  assert.equal(tracker.db.checks().length, 1);
  assert.equal(tracker.db.checks()[0].trigger, 'telegram');
  assert.match(api.calls[1].data.text, /уже выполняется/);
  authorize({}); await tracker.refreshPromise; await bot.flush();
  const report = api.calls.at(-1).data;
  assert.equal(report.chat_id, ownerId); assert.match(report.text, /Успешно/);
  assert.equal(tracker.db.get('SELECT COUNT(*) AS n FROM telegram_outbox WHERE delivered_at IS NOT NULL').n, 1);
});

test('update offset is stored before dispatch and prevents replay after restart', async t => {
  const {tracker, bot, api, root} = setup(t);
  let starts = 0;
  tracker.startRefresh = () => {assert.equal(tracker.db.setting(bot.offsetKey), 43); starts++; return true;};
  api.fail = new TelegramError('transport');
  await assert.rejects(bot.handleUpdate(update(42, '/check')));
  await bot.handleUpdate(update(42, '/check'));
  assert.equal(starts, 1);
  await bot.close(); await tracker.close();
  const secondTracker = new Tracker(root, {client: {}}); cleanup(t, () => secondTracker.close());
  secondTracker.startRefresh = () => {starts++; return true;};
  const secondBot = new TelegramBot(secondTracker, {ownerId, api: fakeApi(), logger: () => {}}); cleanup(t, () => secondBot.close());
  await secondBot.handleUpdate(update(42, '/check'));
  assert.equal(starts, 1);
});

test('notifications wait for backup completion and report its final failure', async t => {
  const {tracker, bot, api} = setup(t, {client: {authorizedUser: async () => ({}), cart: async () => [], favorites: async () => []}});
  let enteredBackup, failBackup;
  const entered = new Promise(resolve => {enteredBackup = resolve;});
  const backup = new Promise((_, reject) => {failBackup = reject;});
  tracker.db.backup = () => {enteredBackup(); return backup;};
  cleanup(t, () => failBackup(new Error('Synthetic backup failure')));
  const refresh = tracker.refreshNow('manual');
  await entered;
  assert.equal(tracker.db.checks()[0].status, 'success');
  await bot.flush(); assert.equal(api.calls.length, 0);
  failBackup(new Error('Synthetic backup failure'));
  await refresh; await bot.flush();
  assert.match(api.calls[0].data.text, /Ошибка/);
  assert.doesNotMatch(api.calls[0].data.text, /Успешно/);
});

test('scheduled, website, CLI and Telegram checks each generate one durable notification', async t => {
  const {tracker, bot, api} = setup(t);
  for (const trigger of ['schedule', 'manual', 'cli', 'telegram']) finish(tracker.db, trigger);
  await bot.flush(); await bot.flush();
  assert.equal(api.calls.length, 4);
  assert.ok(api.calls.every(call => call.data.chat_id === ownerId));
  assert.match(api.calls[0].data.text, /По расписанию/);
  assert.match(api.calls[1].data.text, /Из приложения/);
  assert.match(api.calls[2].data.text, /Из командной строки/);
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
  const workingApi = fakeApi(), resumed = new TelegramBot(restarted, {ownerId, api: workingApi, logger: () => {}});
  cleanup(t, () => resumed.close());
  await resumed.flush(); await resumed.flush();
  assert.equal(workingApi.calls.length, 1); assert.match(workingApi.calls[0].data.text, /сессия истекла/);
});

test('first activation skips historical checks but recovers an interrupted subsequent collection', async t => {
  const root = temporary(t), tracker = new Tracker(root, {client: {}}); cleanup(t, () => tracker.close());
  finish(tracker.db);
  const api = fakeApi(), bot = new TelegramBot(tracker, {ownerId, api, logger: () => {}}); cleanup(t, () => bot.close());
  await bot.flush(); assert.equal(api.calls.length, 0);
  tracker.db.startCheck('manual');
  await bot.close(); await tracker.close();
  const restarted = new Tracker(root, {client: {}}); cleanup(t, () => restarted.close());
  const resumed = new TelegramBot(restarted, {ownerId, api, logger: () => {}}); cleanup(t, () => resumed.close());
  await resumed.flush(); assert.match(api.calls[0].data.text, /Прервана/);
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
  assert.match(report, /Изменений цен: 1/); assert.match(report, /200,00 ₽ → 150,00 ₽/);
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
