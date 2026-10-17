import {validateCapturedRequest} from './network-capture.js';
import {readBounded, retryAfterMs, inspectOzonHtml, redirectSignals} from './probe.js';
import {OzonSession, OZON_JSON_PATH} from './session.js';

export const JSON_LIMIT_BYTES = 8 * 1024 * 1024;

// Only the observed redirect form is accepted. It cannot replace the inner page
// or turn this transport into a reader of arbitrary account/API endpoints.
export function ozonRedirect(original, previous, location) {
  if (typeof location !== 'string' || !location || /[\s\\]/.test(location)) return null;
  try {
    if (location.startsWith('//')) return null;
    if (/^https?:\/\//i.test(location) && !location.startsWith('https://www.ozon.ru/')) return null;
    const target = new URL(location, previous), source = new URL(original);
    if (target.origin !== source.origin || target.pathname !== OZON_JSON_PATH || target.username || target.password || target.hash
      || target.searchParams.getAll('url').length !== 1 || target.searchParams.get('url') !== source.searchParams.get('url')
      || target.searchParams.getAll('__rr').length !== 1 || !/^[12]$/.test(target.searchParams.get('__rr'))
      || [...target.searchParams.keys()].some(key => !['url', '__rr'].includes(key))) return null;
    return target.href;
  } catch {return null;}
}

// One logical read; at most two verified redirects, no automatic retries.
export async function requestOzonJson(captured, {fetchImpl = fetch, current = Date.now, timeoutMs = 20000,
  session, maxRedirects = 2} = {}) {
  const request = validateCapturedRequest(captured);
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 2) throw new RangeError('Invalid redirect limit');
  session ??= new OzonSession(request.headers.cookie, {current});
  const summary = {checked_at: new Date(current()).toISOString(), target_kind: request.operation,
    external_id: request.external_id, http_status: null, outcome: 'network_error', body_bytes: 0, retry_after_ms: 0,
    requests_made: 0, redirects_followed: 0, session_updated: false};
  let response;
  try {
    const signal = AbortSignal.timeout(timeoutMs), visited = new Set([request.url]);
    let url = request.url;
    while (true) {
      const headers = {...request.headers, cookie: await session.header(url)};
      summary.requests_made++;
      response = await fetchImpl(url, {method: 'GET', headers, redirect: 'manual', signal});
      summary.http_status = response.status;
      summary.retry_after_ms = retryAfterMs(response.headers.get('retry-after'), current());
      summary.session_updated = await session.absorb(response.headers, url) || summary.session_updated;
      if (response.status < 300 || response.status >= 400) break;
      summary.signals = redirectSignals(url, response.headers.get('location'));
      summary.retry_after_ms = retryAfterMs(response.headers.get('retry-after'), current());
      const next = ozonRedirect(request.url, url, response.headers.get('location'));
      await response.body?.cancel();
      if (![301, 302, 303, 307, 308].includes(response.status) || !next || visited.has(next)
        || summary.redirects_followed >= maxRedirects || summary.retry_after_ms > 0) {
        summary.outcome = 'redirect';
        return {summary};
      }
      visited.add(next); url = next; summary.redirects_followed++;
    }
    const discard = async outcome => {
      summary.outcome = outcome;
      try {await response.body?.cancel();} catch { /* Do not log raw transport errors. */ }
      return {summary};
    };
    if (response.status === 429) {
      summary.retry_after_ms = retryAfterMs(response.headers.get('retry-after'), current());
      return await discard('rate_limited');
    }
    if (response.status === 401) return await discard('login_required');
    if (response.status === 403) return await discard('access_limited');
    if (response.status !== 200) return await discard('http_error');
    const payload = await readBounded(response, JSON_LIMIT_BYTES);
    summary.body_bytes = payload.bytes;
    if (payload.too_large) {summary.outcome = 'response_too_large'; return {summary};}
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      const signals = inspectOzonHtml(payload.body);
      summary.outcome = signals.access_limited ? 'access_limited' : signals.login_required ? 'login_required' : 'unexpected_content';
      return {summary};
    }
    let data;
    try {data = JSON.parse(payload.body);} catch {summary.outcome = 'unexpected_content'; return {summary};}
    if (!data || typeof data !== 'object' || Array.isArray(data)) {summary.outcome = 'unexpected_content'; return {summary};}
    summary.outcome = 'json_received';
    return {summary, data};
  } catch {
    try {await response?.body?.cancel();} catch { /* Never expose captured headers, URLs or response text. */ }
    return {summary};
  }
}
