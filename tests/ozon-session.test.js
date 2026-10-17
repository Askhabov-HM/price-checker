import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OzonSession} from '../src/providers/ozon/session.js';
import {ozonRedirect, requestOzonJson} from '../src/providers/ozon/json-client.js';
import {temporary} from './helpers.js';

const url = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmy%2Ffavorites%3Fsorting%3Dlast_added';
const captured = {method: 'GET', url, headers: {cookie: 'session=private-session; __Secure-ETC=old'}};
const setCookies = values => new Headers(values.map(value => ['Set-Cookie', value]));

test('the observed redirect updates the scoped session before the second GET, within a shared timeout', async () => {
  const session = new OzonSession(captured.headers.cookie);
  const calls = [];
  const result = await requestOzonJson(captured, {session, fetchImpl: async (target, options) => {
    calls.push({target, options});
    if (calls.length === 1) return new Response('', {status: 307, headers: {
      Location: url + '&__rr=1', 'Set-Cookie': '__Secure-ETC=new; Domain=.ozon.ru; Path=/; Secure; HttpOnly'}});
    assert.equal(options.headers.cookie, 'session=private-session; __Secure-ETC=new');
    return new Response('{"widgetStates":{}}', {headers: {'Content-Type': 'application/json'}});
  }});
  assert.equal(result.summary.outcome, 'json_received');
  assert.equal(result.summary.requests_made, 2);
  assert.equal(result.summary.redirects_followed, 1);
  assert.equal(result.summary.session_updated, true);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.equal(await session.header(url), 'session=private-session; __Secure-ETC=new');
  assert.doesNotMatch(JSON.stringify(result.summary), /private-session|__Secure|ozon\.ru/);
});

test('session updates, expiry and deletions survive a process restart without resurrecting bootstrap cookies', async t => {
  const path = join(temporary(t), '.secrets/session.json');
  let now = Date.now();
  let session = await OzonSession.open(path, captured.headers.cookie, {current: () => now});
  await session.absorb(setCookies(['session=refreshed; Domain=.ozon.ru; Path=/; Secure; Max-Age=60',
    '__Secure-ETC=; Domain=.ozon.ru; Path=/; Secure; Max-Age=0']), url);
  session = await OzonSession.open(path, captured.headers.cookie, {current: () => now});
  assert.equal(await session.header(url), 'session=refreshed');
  now += 30000;
  assert.equal(await session.header(url), 'session=refreshed');
  now += 31000;
  assert.equal(await session.header(url), '');
  await session.save();
  session = await OzonSession.open(path, captured.headers.cookie, {current: () => now});
  assert.equal(await session.header(url), '');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.provider, 'ozon-http-session');
  assert.deepEqual(new Set(saved.shadowed), new Set(['session', '__Secure-ETC']));
});

test('invalid domains, irrelevant paths and broken secure prefixes cannot replace the bootstrap', async () => {
  const session = new OzonSession(captured.headers.cookie);
  const changed = await session.absorb(setCookies(['session=evil; Domain=evil.test; Path=/',
    'session=narrow; Path=/other', '__Secure-ETC=insecure; Path=/', '__Host-bad=bad; Domain=.ozon.ru; Path=/; Secure']), url);
  assert.equal(changed, false);
  assert.equal(await session.header(url), captured.headers.cookie);
  await assert.rejects(() => session.header('https://evil.test' + new URL(url).pathname));
  await assert.rejects(() => session.header('https://www.ozon.ru/my/profile'));
});

test('foreign redirects, replacement of the inner page, unexpected parameters and explicit ports are rejected', () => {
  assert.equal(ozonRedirect(url, url, url + '&__rr=1'), url + '&__rr=1');
  for (const target of ['https://evil.test/', url.replace('www.ozon.ru', 'www.ozon.ru:443') + '&__rr=1',
    '//www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fcart&__rr=1',
    url.replace('%2Fmy%2Ffavorites%3Fsorting%3Dlast_added', '%2Fcart') + '&__rr=1',
    url + '&__rr=1&other=private', url + '&__rr=1&__rr=2', url + '&__rr=1#fragment',
    url + '&__rr=3', 'http://www.ozon.ru/', '/my/profile']) {
    assert.equal(ozonRedirect(url, url, target), null, target);
  }
});

test('a loop or exhausted redirect budget stops, and Retry-After prevents an immediate follow', async () => {
  for (const [options, headers, expectedCalls] of [
    [{}, {Location: url + '&__rr=1'}, 2],
    [{maxRedirects: 0}, {Location: url + '&__rr=1'}, 1],
    [{}, {Location: url + '&__rr=1', 'Retry-After': '7200'}, 1],
  ]) {
    let calls = 0;
    const r = await requestOzonJson(captured, {...options, fetchImpl: async () => {calls++;
      return new Response('', {status: 307, headers});}});
    assert.equal(r.summary.outcome, 'redirect'); assert.equal(calls, expectedCalls);
    assert.equal(r.data, undefined);
  }
  let calls = 0;
  const bounded = await requestOzonJson(captured, {maxRedirects: 1, fetchImpl: async () => {
    calls++; return new Response('', {status: 307, headers: {Location: url + '&__rr=' + calls}});
  }});
  assert.equal(calls, 2); assert.equal(bounded.summary.outcome, 'redirect');
});
