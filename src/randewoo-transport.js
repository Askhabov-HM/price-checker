import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {FetchError, ValidationError} from './errors.js';

export function quote(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new ValidationError('Некорректные заголовки сессии');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

const transientCodes = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56, 92, 95]);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const reasons = {5: 'proxy_dns', 6: 'dns', 7: 'connect', 18: 'incomplete_response', 28: 'timeout',
  35: 'tls_handshake', 52: 'empty_response', 55: 'send', 56: 'receive', 60: 'tls_certificate',
  77: 'tls_ca_file', 92: 'http2_stream', 95: 'http3'};
const marker = '\nPRICE_CHECKER_STATUS:';

export function parseResponse(output) {
  const index = output.lastIndexOf(marker);
  const status = index < 0 ? null : Number(output.slice(index + marker.length).trim()) || null;
  let payload = index < 0 ? output : output.slice(0, index);
  let headers = {};
  // curl can include proxy CONNECT and interim 100 headers before the final response.
  while (/^HTTP\/\S+ \d{3}[^\r\n]*\r?\n/.test(payload)) {
    const match = /\r?\n\r?\n/.exec(payload);
    if (!match) break;
    headers = {};
    for (const line of payload.slice(0, match.index).split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) (headers[line.slice(0, colon).toLowerCase()] ||= []).push(line.slice(colon + 1).trim());
    }
    payload = payload.slice(match.index + match[0].length);
  }
  return {status, headers, payload};
}

export class CurlTransport {
  constructor({spawnProcess = spawn, sleep = delay, random = Math.random,
    logger = entry => console.info(JSON.stringify(entry))} = {}) {
    this.spawnProcess = spawnProcess;
    this.sleep = sleep;
    this.random = random;
    this.logger = logger;
    this.children = new Set();
    this.abort = new AbortController();
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.abort.abort();
    for (const child of this.children) child.kill();
  }

  async request(path, {method = 'GET', json = false, session, data, headers = [], checkId = null} = {}) {
    if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\r\n\\\0#]/.test(path)) throw new ValidationError('Недопустимый адрес запроса');
    const pathname = path.split('?')[0];
    const allowed = ['/cart', '/favorites', '/cabinet/favorites', '/front_api/cart/new_cart', '/front_api/csrf',
      '/front_api/auth/login/mobile/sms', '/front_api/auth/login/mobile'];
    if (!allowed.includes(pathname) && !/^\/product\/[^/?]+$/.test(pathname)) throw new ValidationError('Запрос не относится к спискам или товарам');
    if (!['GET', 'POST'].includes(method)) throw new ValidationError('Недопустимый метод запроса');
    const config = ['url = ' + quote('https://randewoo.ru' + path), 'silent', 'show-error', 'include',
      'connect-timeout = 10', 'max-time = 30', 'proto = "=https"', 'request = ' + quote(method),
      'write-out = "\\nPRICE_CHECKER_STATUS:%{http_code}"',
      'user-agent = ' + quote(session?.user_agent || 'PriceChecker/1.0'),
      'header = ' + quote('Accept: ' + (json ? 'application/json' : 'text/html'))];
    if (session?.cookie) config.push('cookie = ' + quote(session.cookie));
    if (data !== undefined) config.push('header = "Content-Type: application/json"', 'data = ' + quote(JSON.stringify(data)));
    for (const header of headers) config.push('header = ' + quote(header));
    if (pathname === '/favorites') config.push('header = "Content-Type: application/json"');
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.closed) throw new FetchError('Приложение останавливается');
      const started = Date.now();
      const result = await this.execute(config);
      const response = parseResponse(result.output);
      const retryAfter = response.headers['retry-after']?.[0];
      let wait = 1000 * 2 ** (attempt - 1) + Math.floor(this.random() * 250);
      if (retryAfter) {
        const requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(requested)) wait = Math.max(wait, requested);
      }
      const retry = method === 'GET' && attempt < 3 && !this.closed && !result.failure && wait <= 10000
        && (transientCodes.has(result.code) || result.code === 0 && transientStatuses.has(response.status));
      // Deliberate allowlist: no raw stderr, headers, query, payload, phone, code or credentials.
      this.logger({time: new Date().toISOString(), event: 'randewoo_request', path: pathname, method,
        check_id: checkId, attempt, http_status: response.status, curl_code: result.code,
        duration_ms: Date.now() - started, error: result.failure || (result.code ? reasons[result.code] || 'curl_failure' : null),
        retry, ...(retry ? {retry_in_ms: wait} : {})});
      if (retry) {
        try {await this.sleep(wait, undefined, {signal: this.abort.signal});}
        catch {throw new FetchError('Приложение останавливается');}
        continue;
      }
      if (this.closed) throw new FetchError('Приложение останавливается');
      if (result.failure || result.code !== 0) {
        const reason = result.failure || reasons[result.code] || 'curl_failure';
        throw new FetchError(result.failure === 'curl_missing' ? 'Не найдена программа curl'
          : result.failure === 'response_too_large' ? 'Слишком большой ответ Randewoo'
          : `Ошибка соединения с Randewoo (curl ${result.code ?? '—'}: ${reason})`);
      }
      return response;
    }
  }

  execute(config) {
    return new Promise(resolve => {
      const child = this.spawnProcess(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-q', '--config', '-'],
        {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      this.children.add(child);
      const chunks = []; let bytes = 0, settled = false;
      const finish = (code, failure = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        resolve({code, failure, output: Buffer.concat(chunks).toString('utf8')});
      };
      const timer = setTimeout(() => {child.kill(); finish(28);}, 40000);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) {child.kill(); finish(null, 'response_too_large');}
        else chunks.push(chunk);
      });
      // Drain stderr without persisting site-controlled text or sensitive headers.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', error => finish(null, error.code === 'ENOENT' ? 'curl_missing' : 'spawn_failure'));
      child.on('close', code => finish(code));
      child.stdin.end(config.join('\n'));
    });
  }
}
