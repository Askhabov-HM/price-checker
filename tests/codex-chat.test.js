import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {Tracker} from '../src/service.js';
import {TelegramBot, TelegramError} from '../src/telegram.js';
import {CodexRunner, CodexError, splitTelegramText} from '../src/codex-chat.js';
import {cleanup, temporary} from './helpers.js';

const ownerId = 670157270, sessionA = '01a14683-f543-78f3-9e63-c8bd8230e8a1', sessionB = '01a14683-f543-78f3-9e63-c8bd8230e8a2';
const update = (id, text, extra = {}) => ({update_id: id, message: {from: {id: ownerId}, chat: {id: ownerId, type: 'private'}, text, ...extra}});
function fakeRunner(handler) {
  return {calls: [], async turn(request) {
    this.calls.push(request); request.onSession(request.sessionId || sessionA);
    return handler ? handler(request) : {sessionId: request.sessionId || sessionA, text: 'Ответ: ' + request.prompt};
  }, close() {}};
}
function setup(t, {root = temporary(t), runner = fakeRunner()} = {}) {
  const tracker = new Tracker(root, {client: {}}), logs = [], sent = [];
  cleanup(t, () => tracker.close());
  const api = {async call(method, data) {if (method === 'sendMessage') sent.push(data.text); return true;}, close() {}};
  const bot = new TelegramBot(tracker, {ownerId, api, publicOrigin: 'https://prices.example', codexRunner: runner, logger: entry => logs.push(entry)});
  cleanup(t, () => bot.close());
  return {tracker, bot, chat: bot.chat, runner, api, logs, sent, root};
}

test('private owner text is queued atomically with offset and duplicate updates never call Codex twice', async t => {
  const {tracker, bot, chat, runner} = setup(t);
  await bot.handleUpdate(update(1, 'Секретное контрольное слово'));
  await bot.handleUpdate(update(1, 'Секретное контрольное слово'));
  for (const extra of [{from: {id: 1}}, {from: {id: ownerId, is_bot: true}}, {chat: {id: 1, type: 'private'}}, {chat: {id: ownerId, type: 'group'}}]) {
    await bot.handleUpdate(update(tracker.db.setting(bot.offsetKey), 'Чужой текст', extra));
  }
  assert.equal(tracker.db.get('SELECT COUNT(*) AS n FROM telegram_ai_messages').n, 1);
  assert.equal(runner.calls.length, 0);
  await chat.processNext(); await chat.processNext();
  assert.equal(runner.calls.length, 1);
  const original = chat.enqueue; chat.enqueue = () => {throw new Error('Synthetic storage failure');};
  const offset = tracker.db.setting(bot.offsetKey);
  await assert.rejects(bot.handleUpdate(update(100, 'Не терять сообщение')), /storage/);
  assert.equal(tracker.db.setting(bot.offsetKey), offset);
  chat.enqueue = original;
});

test('messages run sequentially, save the session immediately and resume it after restart', async t => {
  const first = setup(t);
  await first.bot.handleUpdate(update(1, 'Запомни ЛИМОН742'));
  await first.bot.handleUpdate(update(2, 'Повтори слово'));
  await first.chat.processNext(); await first.chat.processNext(); await first.bot.flush();
  assert.equal(first.runner.calls[0].sessionId, null);
  assert.equal(first.runner.calls[1].sessionId, sessionA);
  assert.deepEqual(first.sent, ['Ответ: Запомни ЛИМОН742', 'Ответ: Повтори слово']);
  await first.bot.close(); await first.tracker.close();
  const second = setup(t, {root: first.root});
  await second.bot.handleUpdate(update(3, 'Продолжим'));
  await second.chat.processNext();
  assert.equal(second.runner.calls[0].sessionId, sessionA);
  assert.equal(second.tracker.db.get('SELECT COUNT(*) AS n FROM telegram_ai_messages').n, 3);
});

test('waiting for Codex never blocks /status or /check and parallel AI workers share one turn', async t => {
  let done, entered;
  const pending = new Promise(resolve => {done = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const fixture = setup(t, {runner: fakeRunner(async () => {entered(); await pending; return {sessionId: sessionA, text: 'Готово'};})});
  cleanup(t, done);
  let checks = 0; fixture.tracker.startRefresh = () => {checks++; return true;};
  await fixture.bot.handleUpdate(update(1, 'Долгий вопрос'));
  const processing = fixture.chat.processNext(); await started;
  assert.equal(fixture.tracker.db.get('SELECT session_id FROM telegram_dialogues').session_id, sessionA);
  assert.equal(fixture.chat.processNext(), processing);
  await fixture.bot.handleUpdate(update(2, '/status'));
  await fixture.bot.handleUpdate(update(3, '/check_randewoo'));
  assert.equal(checks, 1); assert.equal(fixture.runner.calls.length, 1);
  assert.match(fixture.sent[0], /Codex:.*1/);
  done(); await processing;
});

test('/new starts a separate session only after pending answers are delivered and preserves old history', async t => {
  const {bot, chat, tracker, runner, sent} = setup(t);
  await bot.handleUpdate(update(1, 'Первый диалог'));
  await bot.handleUpdate(update(2, '/new'));
  assert.match(sent.at(-1), /Дождись/);
  await chat.processNext(); await bot.flush();
  await bot.handleUpdate(update(3, '/new'));
  assert.match(sent.at(-1), /Начат новый/);
  await bot.handleUpdate(update(4, 'Второй диалог')); await chat.processNext();
  assert.equal(runner.calls[1].sessionId, null);
  assert.equal(tracker.db.get('SELECT COUNT(*) AS n FROM telegram_dialogues').n, 2);
  assert.equal(tracker.db.get('SELECT prompt FROM telegram_ai_messages WHERE update_id=1').prompt, 'Первый диалог');
});

test('queued requests survive restart; interrupted turns become notices and are never automatically replayed', async t => {
  const first = setup(t);
  await first.bot.handleUpdate(update(1, 'Прерванный запрос'));
  await first.bot.handleUpdate(update(2, 'Ожидающий запрос'));
  first.tracker.db.run("UPDATE telegram_ai_messages SET status='running' WHERE update_id=1");
  first.tracker.db.run('UPDATE telegram_dialogues SET session_id=?', sessionA);
  await first.bot.close(); await first.tracker.close();
  const second = setup(t, {root: first.root});
  await second.chat.processNext(); await second.bot.flush();
  assert.equal(second.runner.calls.length, 1);
  assert.equal(second.runner.calls[0].prompt, 'Ожидающий запрос');
  assert.equal(second.runner.calls[0].sessionId, sessionA);
  assert.match(second.sent[0], /прерван перезапуском/);
  assert.match(second.sent[1], /Ожидающий/);
});

test('long replies resume delivery from their saved part after Telegram outage and process restart', async t => {
  const answer = 'А'.repeat(3999) + '😀' + '\n' + 'Б'.repeat(4100), parts = splitTelegramText(answer);
  const first = setup(t, {runner: fakeRunner(async () => ({sessionId: sessionA, text: answer}))});
  await first.bot.handleUpdate(update(1, 'Длинный ответ')); await first.chat.processNext();
  let sends = 0;
  first.api.call = async (method, data) => {
    if (++sends === 2) throw new TelegramError('request', 429, 30);
    first.sent.push(data.text);
  };
  const before = Date.now(); await first.bot.flush();
  const row = first.tracker.db.get('SELECT * FROM telegram_ai_messages');
  assert.equal(row.next_part, 1); assert.ok(row.next_attempt_ms >= before + 30000);
  await first.bot.flush(); assert.equal(sends, 2);
  first.tracker.db.run('UPDATE telegram_ai_messages SET next_attempt_ms=0');
  await first.bot.close(); await first.tracker.close();
  const second = setup(t, {root: first.root});
  await second.bot.flush(); await second.bot.flush();
  assert.deepEqual([...first.sent, ...second.sent], parts);
  assert.equal([...first.sent, ...second.sent].join(''), answer);
  assert.equal(second.runner.calls.length, 0);
  assert.equal(second.chat.pending(), 0);
});

test('later replies cannot overtake an earlier reply waiting for Telegram retry', async t => {
  const {bot, chat, tracker, api, sent} = setup(t);
  await bot.handleUpdate(update(1, 'Первый')); await bot.handleUpdate(update(2, 'Второй'));
  await chat.processNext(); await chat.processNext();
  api.call = async () => {throw new TelegramError('transport');};
  await bot.flush();
  api.call = async (method, data) => {sent.push(data.text);};
  await bot.flush(); assert.equal(sent.length, 0);
  tracker.db.run('UPDATE telegram_ai_messages SET next_attempt_ms=0');
  await bot.flush(); assert.deepEqual(sent, ['Ответ: Первый', 'Ответ: Второй']);
});

test('limits and authentication failures produce safe notices while retaining prompts without logging them', async t => {
  for (const reason of ['auth', 'limit', 'timeout', 'request']) {
    const {bot, chat, tracker, sent, logs} = setup(t, {runner: fakeRunner(async () => {throw new CodexError(reason);})});
    await bot.handleUpdate(update(1, 'private-chat-content')); await chat.processNext(); await bot.flush();
    assert.match(sent[0], /Сообщение сохранено/);
    assert.equal(tracker.db.get('SELECT prompt FROM telegram_ai_messages').prompt, 'private-chat-content');
    assert.doesNotMatch(JSON.stringify(logs), /private-chat-content/);
    assert.equal(logs[0].reason, reason);
  }
});

test('queue has a finite size and rejects unknown slash commands without sending them to AI', async t => {
  const {bot, chat, runner, sent} = setup(t);
  for (let id = 1; id <= 11; id++) await bot.handleUpdate(update(id, 'Сообщение ' + id));
  assert.equal(chat.pending(), 10); assert.match(sent.at(-1), /уже 10/);
  await bot.handleUpdate(update(12, '/unknown'));
  assert.equal(chat.pending(), 10); assert.equal(runner.calls.length, 0);
});

function transport(t, {events, pending = false, timeoutMs = 10000} = {}) {
  const root = temporary(t), calls = [];
  const runner = new CodexRunner({executable: join(root, 'synthetic-codex'), workspace: join(root, 'workspace'), timeoutMs,
    spawnProcess: (command, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {queueMicrotask(() => child.emit('close', null)); return true;};
      let input = '';
      child.stdin.on('data', value => {input += value;});
      child.stdin.on('finish', () => {
        calls.push({command, args, options, input});
        if (pending) return;
        queueMicrotask(() => {
          child.stderr.write('synthetic-auth-token private-stderr');
          for (const event of events || [{type: 'thread.started', thread_id: sessionA},
            {type: 'item.completed', item: {type: 'agent_message', text: 'Привет 😀'}}, {type: 'turn.completed'}]) {
            const bytes = Buffer.from(JSON.stringify(event) + '\n');
            child.stdout.write(bytes.subarray(0, bytes.length - 2)); child.stdout.write(bytes.subarray(bytes.length - 2));
          }
          child.emit('close', 0);
        });
      });
      return child;
    }});
  cleanup(t, () => runner.close());
  return {runner, calls};
}

test('CLI uses stdin, explicit session resume, full server access and mandatory completion hooks', async t => {
  const {runner, calls} = transport(t);
  const seen = [];
  const result = await runner.turn({prompt: 'private-prompt', onSession: id => seen.push(id)});
  assert.equal(result.text, 'Привет 😀'); assert.deepEqual(seen, [sessionA]);
  await runner.turn({sessionId: sessionA, prompt: 'Продолжение'});
  assert.deepEqual(calls[1].args.slice(-3), ['resume', sessionA, '-']);
  assert.equal(calls[0].input, 'private-prompt');
  assert.doesNotMatch(JSON.stringify(calls[0].args), /private-prompt/);
  assert.ok(calls[0].args.includes('features.shell_tool=true'));
  assert.ok(calls[0].args.includes('features.hooks=true'));
  assert.ok(calls[0].args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(calls[0].args.includes('--dangerously-bypass-hook-trust'));
  assert.ok(!calls[0].args.includes('--ignore-user-config'));
  assert.ok(calls[0].args.some(arg => arg.includes('$safe-commit-auto')));
  assert.equal(calls[0].options.env.PRICE_CHECKER_TELEGRAM_TOKEN_FILE, undefined);
  assert.equal(calls[0].options.env.HTTP_PROXY, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  await assert.rejects(runner.turn({sessionId: '--last', prompt: 'test'}), /configuration/);
});

test('unverified Git delivery is reported as incomplete even after an agent message', async t => {
  const {runner} = transport(t, {events: [{type:'thread.started',thread_id:sessionA},
    {type:'item.completed',item:{type:'agent_message',text:'Done'}},
    {type:'turn.failed',error:{message:'git_delivery_not_verified'}}]});
  await assert.rejects(runner.turn({prompt:'work'}), error => error.reason === 'git_delivery');
});

test('CLI errors retain only a safe reason, never a server response or authentication secret', async t => {
  const {runner} = transport(t, {events: [{type: 'turn.failed', error: {message: '401 unauthorized synthetic-auth-token'}}]});
  await assert.rejects(runner.turn({prompt: 'test'}), error => {
    assert.equal(error.reason, 'auth'); assert.doesNotMatch(error.message, /synthetic|401|unauthorized/); return true;
  });
});

test('CLI cancellation and timeout terminate the child and remove active-process state', async t => {
  const {runner} = transport(t, {pending: true});
  const abort = new AbortController(), request = runner.turn({prompt: 'test', signal: abort.signal});
  abort.abort(); await assert.rejects(request, /stopped/);
  assert.equal(runner.stoppers.size, 0);
  const timed = transport(t, {pending: true, timeoutMs: 5});
  await assert.rejects(timed.runner.turn({prompt: 'test'}), /timeout/);
  assert.equal(timed.runner.stoppers.size, 0);
});

test('reply splitting preserves every character and never splits a surrogate pair', () => {
  const text = 'Я'.repeat(3999) + '😀' + '\n' + 'Текст\n'.repeat(2000);
  const parts = splitTelegramText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 4000 && !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
  assert.ok(splitTelegramText('А'.repeat(4000) + '\nБ').every(part => part.length <= 4000));
});
