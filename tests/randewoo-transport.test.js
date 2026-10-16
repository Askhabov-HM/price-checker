import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {CurlTransport, parseResponse} from '../src/randewoo-transport.js';
import {Randewoo} from '../src/client.js';
import {AuthError} from '../src/errors.js';

const response = (status = 200, body = 'ok', headers = '') => `HTTP/2 ${status}\r\n${headers}\r\n${body}\nPRICE_CHECKER_STATUS:${status}`;
function fixture(results) {
  const calls = [], logs = [], waits = [];
  const transport = new CurlTransport({logger: entry => logs.push(entry), random: () => 0,
    sleep: async ms => {waits.push(ms);}, spawnProcess: (command, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {queueMicrotask(() => child.emit('close', null));};
      let config = '';
      child.stdin.on('data', chunk => {config += chunk;});
      child.stdin.on('finish', () => {
        calls.push({command, args, options, config});
        const next = results.shift(); assert.ok(next, 'unexpected extra request');
        queueMicrotask(() => {
          if (next.error) return child.emit('error', {code: next.error});
          child.stderr.write('curl: secret-cookie private-phone private-code');
          child.stdout.write(next.output ?? response(next.status));
          child.emit('close', next.code ?? 0);
        });
      });
      return child;
    }});
  return {transport, calls, logs, waits};
}

test('temporary curl failures retry twice, log each attempt and keep credentials out of argv and logs', async () => {
  const {transport, calls, logs, waits} = fixture([{code: 56, output: ''}, {code: 28, output: ''}, {status: 200}]);
  const result = await transport.request('/product/fragrance?private=query', {session: {cookie: 'secret-cookie', user_agent: 'private-agent'}, checkId: 42});
  assert.equal(result.payload, 'ok');
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(logs.map(log => [log.curl_code, log.error, log.retry, log.check_id]), [[56, 'receive', true, 42], [28, 'timeout', true, 42], [0, null, false, 42]]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.args, ['-q', '--config', '-']);
    assert.ok(call.config.includes('secret-cookie'));
    assert.equal(call.options.windowsHide, true);
  }
  assert.doesNotMatch(JSON.stringify(logs), /secret-cookie|private-agent|private-phone|private-code|private=query/);
});

test('HTTP 503 recovers but redirects, unauthorized, forbidden, not-found and certificate errors do not retry', async () => {
  const retry = fixture([{status: 503}, {status: 200}]);
  assert.equal((await retry.transport.request('/cart')).status, 200);
  assert.equal(retry.calls.length, 2);
  for (const status of [301, 302, 401, 403, 404]) {
    const single = fixture([{status}]);
    assert.equal((await single.transport.request('/cart')).status, status);
    assert.equal(single.calls.length, 1);
  }
  const certificate = fixture([{code: 60, output: ''}]);
  await assert.rejects(certificate.transport.request('/cart'), /curl 60: tls_certificate/);
  assert.equal(certificate.calls.length, 1);
});

test('Retry-After is respected and long rate limits stop immediately', async () => {
  const limited = fixture([{output: response(429, '', 'Retry-After: 3\r\n')}, {status: 200}]);
  await limited.transport.request('/cart'); assert.deepEqual(limited.waits, [3000]);
  const long = fixture([{output: response(429, '', 'Retry-After: 120\r\n')}]);
  assert.equal((await long.transport.request('/cart')).status, 429); assert.equal(long.calls.length, 1);
});

test('sending codes and other POST requests never retries a connection failure or HTTP error', async () => {
  for (const next of [{code: 28, output: ''}, {status: 503}, {status: 429}]) {
    const f = fixture([next]);
    const request = f.transport.request('/front_api/auth/login/mobile/sms', {method: 'POST', data: {mobile: 'private-phone', code: 'private-code'}});
    if (next.code) await assert.rejects(request, /curl 28/); else assert.equal((await request).status, next.status);
    assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /private-phone|private-code/);
  }
});

test('exhausted retries give a useful saved error and missing curl fails immediately', async () => {
  const f = fixture(Array.from({length: 3}, () => ({code: 6, output: ''})));
  await assert.rejects(f.transport.request('/cart'), /curl 6: dns/); assert.equal(f.calls.length, 3);
  const missing = fixture([{error: 'ENOENT'}]);
  await assert.rejects(missing.transport.request('/cart'), /Не найдена программа curl/); assert.equal(missing.calls.length, 1);
});

test('shutdown aborts a pending retry and starts no additional requests', async () => {
  const f = fixture([{code: 56, output: ''}]);
  let waiting;
  const entered = new Promise(resolve => {waiting = resolve;});
  f.transport.sleep = async (_ms, _value, {signal}) => {waiting(); await new Promise((_, reject) => signal.addEventListener('abort', reject, {once: true}));};
  const result = f.transport.request('/cart'); await entered; f.transport.close();
  await assert.rejects(result, /останавливается/); assert.equal(f.calls.length, 1);
});

test('response headers and proxy/interim responses are separated from the payload', () => {
  const result = parseResponse('HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n'
    + response(200, '{"ok":true}', 'Set-Cookie: a=b\r\nSet-Cookie: c=d\r\n'));
  assert.equal(result.payload, '{"ok":true}'); assert.equal(result.status, 200);
  assert.deepEqual(result.headers['set-cookie'], ['a=b', 'c=d']);
});

test('expired sessions remain distinct from network and HTTP failures', async () => {
  const client = new Randewoo('unused', {logger: () => {}});
  client.session = () => ({cookie: 'test', user_agent: 'test'});
  client.transport = fixture([{status: 302}]).transport;
  await assert.rejects(client.get('/cart', {authorized: true}), AuthError);
  client.transport = fixture([{status: 403}]).transport;
  await assert.rejects(client.get('/cart', {authorized: true}), error => !(error instanceof AuthError) && /HTTP 403/.test(error.message));
});
