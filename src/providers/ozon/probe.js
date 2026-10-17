import {load} from 'cheerio';
import {probeTarget} from './url.js';

export const PROBE_LIMIT_BYTES = 2 * 1024 * 1024;
export const OZON_INTERVAL_MS = 2 * 60 * 60 * 1000;

// Keep diagnostic comparisons, never the Location URL, query values or credentials.
export function redirectSignals(requestUrl, location) {
  const signals = {redirect_location_present: typeof location === 'string' && location.length > 0,
    redirect_location_valid: false};
  if (!signals.redirect_location_present || /[\r\n\u0000]/.test(location)) return signals;
  let source, destination;
  try {source = new URL(requestUrl); destination = new URL(location, source);} catch {return signals;}
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return signals;
  signals.redirect_location_valid = true;
  signals.redirect_same_origin = destination.origin === source.origin;
  if (signals.redirect_same_origin) {
    signals.redirect_same_path = destination.pathname === source.pathname;
    signals.redirect_query_changed = destination.search !== source.search;
  }
  return signals;
}

// Diagnostic signals only. A bank offer is not evidence of an Ozon Card price.
export function inspectOzonHtml(html) {
  const $ = load(html);
  $('script, style, noscript, template').remove();
  const text = $('body').text().replace(/\s+/gu, ' ').trim();
  const title = $('title').text();
  const limited = /доступ\s+(?:временно\s+)?(?:ограничен|запрещ[её]н)|подтвердите[^.]{0,80}не\s+робот|проверка\s+безопасности|слишком\s+много\s+запросов|access\s+denied|captcha|verify\s+you\s+are\s+human/iu.test(title + ' ' + text.slice(0, 4000));
  const login = /^(?:вход|авторизация)(?:\s|[—–-]|$)/iu.test($('h1').first().text().trim() || title.trim());
  return {
    access_limited: limited,
    login_required: login,
    product_heading: $('h1').length > 0 && !login && !limited,
    bank_price_label: /с\s+банками/iu.test(text),
    other_banks_label: /с\s+другими\s+банками/iu.test(text),
    ozon_card_label: /(?:с|по)\s+Ozon\s+Карт(?:ой|е)/iu.test(text),
  };
}

export function retryAfterMs(value, current = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  if (/^\d+$/.test(value.trim())) {
    const result = Number(value.trim()) * 1000;
    return Math.min(result, 8.64e15 - current);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - current) : 0;
}

export async function readBounded(response, limit = PROBE_LIMIT_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return {body: '', bytes: 0};
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return {body: Buffer.concat(chunks).toString('utf8'), bytes};
      bytes += value.byteLength;
      if (bytes > limit) {await reader.cancel(); return {body: '', bytes, too_large: true};}
      chunks.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
}

// One public GET, no credentials, redirect following, retries, background polling or raw output.
export async function probeOzon(value, {fetchImpl = fetch, current = Date.now, timeoutMs = 20000} = {}) {
  const target = probeTarget(value);
  const result = {checked_at: new Date(current()).toISOString(), target_kind: target.kind,
    external_id: target.external_id, http_status: null, outcome: 'network_error', body_bytes: 0, retry_after_ms: 0};
  let response;
  try {
    response = await fetchImpl(target.url, {redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: {'User-Agent': 'PriceChecker/1.0 (Ozon feasibility probe)', Accept: 'text/html'}});
    result.http_status = response.status;
    const discard = async outcome => {
      result.outcome = outcome;
      try {await response.body?.cancel();} catch { /* Status already determines the result. */ }
      return result;
    };
    if (response.status === 429) {
      result.retry_after_ms = retryAfterMs(response.headers.get('retry-after'), current());
      return await discard('rate_limited');
    }
    if (response.status === 401) return await discard('login_required');
    if (response.status === 403) return await discard('access_limited');
    if (response.status >= 300 && response.status < 400) {
      result.signals = redirectSignals(target.url, response.headers.get('location'));
      result.retry_after_ms = retryAfterMs(response.headers.get('retry-after'), current());
      return await discard('redirect');
    }
    if (response.status !== 200) return await discard('http_error');
    if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) return await discard('unexpected_content');
    const payload = await readBounded(response);
    result.body_bytes = payload.bytes;
    if (payload.too_large) {result.outcome = 'response_too_large'; return result;}
    result.signals = inspectOzonHtml(payload.body);
    result.outcome = result.signals.access_limited ? 'access_limited' : result.signals.login_required ? 'login_required' : 'html_received';
    return result;
  } catch {
    try {await response?.body?.cancel();} catch { /* Never expose a raw network error. */ }
    return result;
  }
}
