import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describeReadRequest, validateCapturedRequest, inspectHar, readHar, saveCapturedRequests, loadCapturedRequest} from '../src/providers/ozon/network-capture.js';
import {requestOzonJson, JSON_LIMIT_BYTES} from '../src/providers/ozon/json-client.js';
import {temporary} from './helpers.js';

const endpoint = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2';
const request = (path = '/my/favorites?sorting=last_added') => ({method: 'GET', url: endpoint + '?url=' + encodeURIComponent(path),
  headers: [{name: 'Cookie', value: 'session=private-cookie'}, {name: 'User-Agent', value: 'Captured browser'},
    {name: 'Referer', value: 'https://www.ozon.ru/my/favorites'}, {name: 'unrelated-secret', value: 'discard-me'}]});
const data = {widgetStates: {'tileGridDesktop-12-default-1': '{}'}, userInfo: {private: 'private-address'}};
const entry = (path, extra = {}) => ({request: request(path), response: {status: 200, content: {text: JSON.stringify(data)}}, ...extra});
const har = entries => ({log: {entries}});

test('only the verified GET page endpoint and supported read contexts are accepted', () => {
  assert.equal(describeReadRequest(request('/cart')).operation, 'cart');
  assert.equal(describeReadRequest(request()).operation, 'favorites');
  assert.equal(describeReadRequest(request('/product/item-123/?at=tracking')).external_id, '123');
  assert.equal(describeReadRequest(request('/modal/pdpListOfBanks?product_id=123')).operation, 'banks');
  assert.equal(describeReadRequest(request('/my/favorites?layout_page_index=2&page=cursor')).initial_page, false);
  const bad = [
    {...request(), method: 'POST'}, {...request(), url: 'https://evil.test/api/entrypoint-api.bx/page/json/v2?url=%2Fcart'},
    {...request(), url: 'https://www.ozon.ru:443/api/entrypoint-api.bx/page/json/v2?url=%2Fcart'},
    {...request(), url: 'https://user:pass@www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fcart'},
    {...request(), url: endpoint.replace('/entrypoint-api.bx/page/json/v2', '/composer-api.bx/_action/cartDelete') + '?url=%2Fcart'},
    {...request(), url: request().url + '&url=%2Fcart'}, {...request(), url: request().url + '&other=action'},
    request('//evil.test/product/123/'), request('/my/favorites?list=123'), request('/my/favorites?wishlistId=123'),
    request('/my/profile'), request('/modal/pdpListOfBanks?product_id=123&action=apply'),
  ];
  for (const value of bad) assert.throws(() => describeReadRequest(value), /GET-запрос/);
});

test('captured headers are scoped, whitelisted and protected against header injection', () => {
  const safe = validateCapturedRequest(request());
  assert.equal(safe.headers.cookie, 'session=private-cookie');
  assert.equal(safe.headers['unrelated-secret'], undefined);
  for (const header of [{name: 'Cookie', value: 'session=foo\r\nInjected: yes'}, {name: 'Origin', value: 'https://evil.test'},
    {name: 'Referer', value: 'https://evil.test/account'}]) {
    assert.throws(() => validateCapturedRequest({...request(), headers: [header]}), /GET-запрос/);
  }
});

test('HAR inspection returns only safe shape metadata, and accepts base64 JSON without exposing sessions or account fields', () => {
  const encoded = entry('/cart'); encoded.response.content = {encoding: 'base64', text: Buffer.from(JSON.stringify(data)).toString('base64')};
  const parsed = inspectHar(har([entry(), encoded, {request: {...request(), method: 'POST'}}, entry('/cart', {response: {status: 403}})]));
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.summary.entries_total, 4);
  assert.equal(parsed.summary.skipped, 2);
  assert.deepEqual(parsed.summary.requests[0].widget_types, ['tileGridDesktop']);
  assert.doesNotMatch(JSON.stringify(parsed.summary), /private-cookie|private-address|discard-me|session=/);
});

test('request import selects full pages instead of a larger paginated fragment, and revalidates persisted operations', t => {
  const root = temporary(t), file = join(root, '.secrets/requests.json');
  const full = entry(); const fragment = entry('/my/favorites?layout_page_index=2&page=cursor');
  fragment.response.content.text = JSON.stringify({widgetStates: {'tileGridDesktop-1-default-2': '{}', 'separator-2-default-2': '{}'}});
  saveCapturedRequests(file, inspectHar(har([fragment, full])));
  assert.equal(loadCapturedRequest(file, 'favorites').initial_page, true);
  const stored = JSON.parse(readFileSync(file, 'utf8')); stored.requests.cart = stored.requests.favorites;
  writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => loadCapturedRequest(file, 'cart'), /GET-запрос/);
  assert.throws(() => saveCapturedRequests(join(root, 'fragment.json'), inspectHar(har([fragment]))), /Не найдено/);
});

test('missing cookies and non-JSON HAR responses are never imported as an account connection', t => {
  const root = temporary(t), sanitized = entry(); sanitized.request.headers = [];
  assert.throws(() => saveCapturedRequests(join(root, 'sanitized.json'), inspectHar(har([sanitized]))), /Cookie/);
  const html = entry(); html.response.content.text = '<h1>Login</h1>';
  assert.equal(inspectHar(har([html])).candidates.length, 0);
  const file = join(root, 'capture.har'); writeFileSync(file, JSON.stringify(har([entry()])));
  assert.equal(readHar(file).candidates.length, 1);
  writeFileSync(file, 'not JSON'); assert.throws(() => readHar(file), /JSON/);
});

test('JSON transport preserves credentials only in the request and disables fetch automatic redirects', async () => {
  let calls = 0;
  const result = await requestOzonJson(request(), {fetchImpl: async (url, options) => {
    calls++; assert.equal(url, request().url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, 'session=private-cookie');
    return new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json; charset=utf-8'}});
  }});
  assert.equal(calls, 1); assert.equal(result.summary.outcome, 'json_received');
  assert.deepEqual(result.data, data);
  assert.doesNotMatch(JSON.stringify(result.summary), /private|session=|cookie|https?:\/\//);
});

test('redirects, rate limits, login and access restrictions stop after one attempt without returning the private response', async () => {
  for (const [status, outcome] of [[307, 'redirect'], [401, 'login_required'], [403, 'access_limited'], [429, 'rate_limited'], [500, 'http_error']]) {
    let calls = 0;
    const r = await requestOzonJson(request(), {fetchImpl: async () => {calls++;return new Response('private-response', {status, headers: {'Retry-After': '10800'}});}});
    assert.equal(calls, 1); assert.equal(r.summary.outcome, outcome); assert.equal(r.data, undefined);
    if (status === 429) assert.equal(r.summary.retry_after_ms, 10800000);
    assert.doesNotMatch(JSON.stringify(r), /private/);
  }
});

test('redirect diagnostics distinguish URL changes without following the redirect or exposing private Location values', async () => {
  for (const [location, expected] of [
    [request().url + '&private=secret-token', {redirect_same_origin: true, redirect_same_path: true, redirect_query_changed: true}],
    ['/login?account=private-person', {redirect_same_origin: true, redirect_same_path: false, redirect_query_changed: true}],
    ['https://external.test/account?private=secret-token', {redirect_same_origin: false}],
  ]) {
    let calls = 0;
    const r = await requestOzonJson(request(), {fetchImpl: async () => {calls++; return new Response('', {status: 307,
      headers: {Location: location, 'Retry-After': '10800'}});}});
    assert.equal(calls, 1); assert.equal(r.summary.outcome, 'redirect'); assert.equal(r.data, undefined);
    assert.equal(r.summary.retry_after_ms, 10800000);
    assert.deepEqual(r.summary.signals, {redirect_location_present: true, redirect_location_valid: true, ...expected});
    assert.doesNotMatch(JSON.stringify(r), /secret-token|private-person|external\.test|\/login|private=/);
  }
  const missing = await requestOzonJson(request(), {fetchImpl: async () => new Response('', {status: 307})});
  assert.deepEqual(missing.summary.signals, {redirect_location_present: false, redirect_location_valid: false});
  const invalid = await requestOzonJson(request(), {fetchImpl: async () => new Response('', {status: 307, headers: {Location: 'javascript:private-secret'}})});
  assert.equal(invalid.summary.signals.redirect_location_valid, false);
  assert.doesNotMatch(JSON.stringify(invalid), /private-secret/);
});

test('HTML challenges, malformed JSON and large streams do not become data; transport errors are redacted', async () => {
  const html = await requestOzonJson(request(), {fetchImpl: async () => new Response('<h1>Доступ ограничен</h1>', {headers: {'Content-Type': 'text/html'}})});
  assert.equal(html.summary.outcome, 'access_limited');
  const malformed = await requestOzonJson(request(), {fetchImpl: async () => new Response('{"private":', {headers: {'Content-Type': 'application/json'}})});
  assert.equal(malformed.summary.outcome, 'unexpected_content');
  let cancelled = false;
  const stream = new ReadableStream({pull(c) {c.enqueue(new Uint8Array(JSON_LIMIT_BYTES + 1));}, cancel() {cancelled = true;}});
  const large = await requestOzonJson(request(), {fetchImpl: async () => new Response(stream, {headers: {'Content-Type': 'application/json'}})});
  assert.equal(large.summary.outcome, 'response_too_large'); assert.equal(cancelled, true);
  const failed = await requestOzonJson(request(), {fetchImpl: async () => {throw Error('private-cookie private-address');}});
  assert.equal(failed.summary.outcome, 'network_error'); assert.doesNotMatch(JSON.stringify(failed), /private/);
});
