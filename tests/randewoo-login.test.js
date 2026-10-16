import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {RandewooLogin} from '../src/randewoo-login.js';
import {Tracker} from '../src/service.js';
import {AuthError, FetchError} from '../src/errors.js';
import {cleanup, temporary} from './helpers.js';

const guest = '<meta name="csrf-token" content="private-csrf"><script>gon.cap_enabled=true;gon.cap_server="https://captcha.randewoo.ru";gon.cap_site_key="public-site-key";</script>';
const authorized = '<script>gon.user={"is_authorized":true};</script>';
const reply = (payload, status = 200, cookies = []) => ({payload: typeof payload === 'string' ? payload : JSON.stringify(payload), status, headers: {'set-cookie': cookies}});
function setup(t, responses) {
  let time = Date.now(); const calls = [], saved = [];
  const transport = {request: async (path, options) => {calls.push({path, ...options}); const result = responses.shift(); if (result instanceof Error) throw result; assert.ok(result); return result;}};
  const login = new RandewooLogin(transport, data => saved.push(data), {now: () => time});
  t.after(() => login.clear());
  return {login, transport, calls, saved, advance: ms => {time += ms;}};
}
async function send(f, key = 'browser-one') {
  const prepared = await f.login.prepare(key);
  const data = {challenge_id: prepared.challenge_id, phone: '+7 (999) 123-45-67', cap_token: 'private-captcha-token'};
  await f.login.send(key, data);
  return {...data, code: '1234'};
}

test('phone login preserves guest cookies, confirms authorization and only then saves the new session', async t => {
  const f = setup(t, [reply(guest, 200, ['_session=guest; Path=/; Secure', 'discard=old; Path=/']), reply({estimate: 90}),
    reply({userData: {}}, 200, ['_session=authenticated; Path=/; Secure', 'discard=; Max-Age=0', 'foreign=secret; Domain=evil.example']), reply(authorized)]);
  const data = await send(f);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(await f.login.confirm('browser-one', data), {connected: true});
  assert.deepEqual(f.saved, [{cookie: '_session=authenticated', user_agent: 'PriceChecker/1.0'}]);
  assert.equal(f.calls[1].method, 'POST'); assert.equal(f.calls[1].data.mobile, '(999) 123-45-67');
  assert.equal(f.calls[1].data.country_code, 'RU'); assert.equal(f.calls[1].data.subscription_type, undefined);
  assert.ok(f.calls[1].headers.includes('X-CSRF-Token: private-csrf'));
  assert.equal(f.calls[3].session.cookie, '_session=authenticated');
  assert.equal(f.login.pending.size, 0);
});

test('a rejected code and a success response without an authorized session cannot replace existing credentials', async t => {
  const f = setup(t, [reply(guest), reply({estimate: 60}), reply({error: 'private account details'}, 422), reply({}), reply('gon.user={"is_authorized":false};')]);
  const data = await send(f);
  await assert.rejects(f.login.confirm('browser-one', data), /Код не подошёл/);
  await assert.rejects(f.login.confirm('browser-one', data), AuthError);
  assert.equal(f.saved.length, 0);
});

test('login challenges are bound to the browser and expire; invalid input never reaches Randewoo', async t => {
  const f = setup(t, [reply(guest)]);
  const {challenge_id} = await f.login.prepare('browser-one');
  await assert.rejects(f.login.send('browser-two', {challenge_id, phone: '+79991234567', cap_token: 'test'}), /истекло/);
  for (const phone of ['+1 999 123 4567', 'https://evil.example', 79991234567]) await assert.rejects(f.login.send('browser-one', {challenge_id, phone, cap_token: 'test'}), /номер/);
  await assert.rejects(f.login.send('browser-one', {challenge_id, phone: '+79991234567', cap_token: ''}), /CAPTCHA/);
  assert.equal(f.calls.length, 1);
  f.advance(10 * 60000 + 1);
  await assert.rejects(f.login.confirm('browser-one', {challenge_id, code: '1234'}), /истекло/);
});

test('SMS requests are throttled globally and a network failure is never sent twice', async t => {
  const f = setup(t, [reply(guest), new FetchError('network'), reply({estimate: 120})]);
  const {challenge_id} = await f.login.prepare('browser-one');
  const data = {challenge_id, phone: '+79991234567', cap_token: 'test'};
  await assert.rejects(f.login.send('browser-one', data), /network/);
  await assert.rejects(f.login.send('browser-one', data), error => error.status === 429);
  assert.equal(f.calls.length, 2);
  f.advance(60001); await f.login.send('browser-one', data);
  f.advance(60001); await assert.rejects(f.login.send('browser-one', data), error => error.status === 429);
});

test('five incorrect codes invalidate the challenge, and cancellation cannot erase a newer challenge', async t => {
  const f = setup(t, [reply(guest), reply({}), ...Array.from({length: 5}, () => reply({}, 422)), reply(guest)]);
  const data = await send(f);
  for (let n = 0; n < 5; n++) await assert.rejects(f.login.confirm('browser-one', data), /Код не подошёл/);
  await assert.rejects(f.login.confirm('browser-one', data), error => error.status === 429);
  const next = await f.login.prepare('browser-one');
  f.login.cancel('browser-one', data.challenge_id);
  assert.equal(f.login.pending.get('browser-one').id, next.challenge_id);
});

test('cancel during verification prevents a late response from saving credentials', async t => {
  const f = setup(t, [reply(guest), reply({})]); const data = await send(f);
  let release;
  f.transport.request = () => new Promise(resolve => {release = resolve;});
  const confirming = f.login.confirm('browser-one', data);
  f.login.cancel('browser-one', data.challenge_id); release(reply({}));
  await assert.rejects(confirming, /истекло/); assert.equal(f.saved.length, 0);
});

test('a failed login keeps the actual secret file and its stored status intact', async t => {
  const root = temporary(t), tracker = new Tracker(root); cleanup(t, () => tracker.close());
  tracker.saveSession({cookie: 'existing-session', user_agent: 'existing-agent'});
  tracker.db.setSetting('auth_status', 'ok');
  const before = readFileSync(join(root, '.secrets/randewoo-session.json'), 'utf8');
  const f = setup(t, [reply(guest), reply({}), reply({}, 422)]);
  tracker.randewooLogin.transport = f.transport;
  const data = await send({login: tracker.randewooLogin});
  await assert.rejects(tracker.randewooLogin.confirm('browser-one', data));
  assert.equal(readFileSync(join(root, '.secrets/randewoo-session.json'), 'utf8'), before);
  assert.equal(tracker.status().auth_status, 'ok');
});
