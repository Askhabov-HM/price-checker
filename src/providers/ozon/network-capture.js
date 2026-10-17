import {readFileSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync, lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {ozonProduct, OZON_ORIGIN} from './url.js';

const MAX_HAR_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const acceptedHeaders = new Set(['cookie', 'user-agent', 'accept', 'accept-language', 'origin', 'referer',
  'x-o3-app-name', 'x-o3-app-version', 'x-o3-manifest-version', 'x-o3-page-type']);
const keyNames = object => Object.keys(object || {}).filter(key => /^[a-z][a-z0-9_-]{0,80}$/i.test(key)).slice(0, 60);
const invalid = () => new ValidationError('Нужен захваченный GET-запрос чтения страницы Ozon из Network.');

function sourceUrl(value) {
  if (typeof value !== 'string' || /[\\\r\n]/.test(value)) throw invalid();
  let url;
  try {url = new URL(value);} catch {throw invalid();}
  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  if (url.origin !== OZON_ORIGIN || authority !== 'www.ozon.ru' || url.username || url.password || url.hash) throw invalid();
  return url;
}

export function describeReadRequest(request) {
  if (request?.method !== 'GET') throw invalid();
  const url = sourceUrl(request.url);
  // Verified through Chrome DevTools Network. Account mutations use different endpoints.
  if (url.pathname !== '/api/entrypoint-api.bx/page/json/v2' || url.searchParams.getAll('url').length !== 1
    || [...url.searchParams.keys()].some(key => key !== 'url')) throw invalid();
  const pageText = url.searchParams.get('url');
  if (!pageText || !pageText.startsWith('/') || pageText.startsWith('//') || /[\\\r\n]/.test(pageText)) throw invalid();
  const page = sourceUrl(new URL(pageText, OZON_ORIGIN).href);
  const initial_page = !page.searchParams.has('page') && !page.searchParams.has('paginator_token')
    && (!page.searchParams.has('layout_page_index') || page.searchParams.get('layout_page_index') === '1');
  const description = {external_id: null, endpoint: url.pathname, initial_page};
  if (page.pathname.replace(/\/$/, '') === '/cart') return {...description, operation: 'cart'};
  if (page.pathname.replace(/\/$/, '') === '/my/favorites'
    && ![...page.searchParams.keys()].some(key => /list|wishlist/i.test(key))) return {...description, operation: 'favorites'};
  if (page.pathname === '/modal/pdpListOfBanks' && page.searchParams.getAll('product_id').length === 1
    && /^[1-9]\d{0,19}$/.test(page.searchParams.get('product_id'))
    && [...page.searchParams.keys()].every(key => key === 'product_id')) {
    return {...description, operation: 'banks', external_id: page.searchParams.get('product_id')};
  }
  try {return {...description, operation: 'product', external_id: ozonProduct(page.href).external_id};}
  catch {throw invalid();}
}

function cleanHeaders(request) {
  const entries = Array.isArray(request.headers) ? request.headers : Object.entries(request.headers || {}).map(([name, value]) => ({name, value}));
  const headers = {};
  for (const header of entries) {
    if (typeof header?.name !== 'string') continue;
    const name = header.name.toLowerCase();
    if (!acceptedHeaders.has(name)) continue;
    if (typeof header.value !== 'string' || /[\r\n\u0000]/.test(header.value) || header.value.length > 50000) throw invalid();
    if (name === 'origin' && header.value !== OZON_ORIGIN) throw invalid();
    if (name === 'referer') sourceUrl(header.value);
    headers[name] = header.value;
  }
  if (!headers.cookie && Array.isArray(request.cookies) && request.cookies.length) {
    headers.cookie = request.cookies.map(cookie => {
      if (typeof cookie?.name !== 'string' || !/^[a-z0-9_!#$%&'*+.^`|~-]+$/i.test(cookie.name)
        || typeof cookie.value !== 'string' || /[\r\n\u0000;]/.test(cookie.value)) throw invalid();
      return cookie.name + '=' + cookie.value;
    }).join('; ');
    if (headers.cookie.length > 50000) throw invalid();
  }
  return headers;
}

export function validateCapturedRequest(request) {
  const description = describeReadRequest(request);
  return {method: 'GET', url: request.url, headers: cleanHeaders(request), ...description};
}

function responseJson(content) {
  if (typeof content?.text !== 'string' || content.text.length > MAX_JSON_BYTES * 1.4) return null;
  let value;
  try {
    const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) return null;
    value = JSON.parse(text);
  } catch {return null;}
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function jsonShape(data) {
  const widgets = data?.widgetStates && typeof data.widgetStates === 'object' && !Array.isArray(data.widgetStates) ? data.widgetStates : {};
  return {keys: keyNames(data), widget_types: [...new Set(keyNames(widgets).map(key => key.replace(/-\d.*$/, '')))], widget_count: Object.keys(widgets).length};
}

// HAR is parsed as JSON, never executed as cURL, shell commands, scripts or DevTools snippets.
export function inspectHar(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new ValidationError('Некорректный HAR: отсутствует log.entries.');
  const candidates = [];
  let skipped = 0;
  for (const [index, entry] of entries.entries()) {
    let request;
    try {request = validateCapturedRequest(entry.request);} catch {skipped++; continue;}
    if (entry.response?.status !== 200) {skipped++; continue;}
    const data = responseJson(entry.response.content);
    if (!data) {skipped++; continue;}
    candidates.push({entry_index: index, request, data, shape: jsonShape(data)});
  }
  const summary = candidates.map(({entry_index, request, shape}) => ({entry_index, operation: request.operation,
    endpoint: request.endpoint, session_header_present: Boolean(request.headers.cookie), ...shape}));
  return {candidates, summary: {entries_total: entries.length, skipped, requests: summary}};
}

export function readHar(path) {
  if (!statSync(path).isFile() || statSync(path).size > MAX_HAR_BYTES) throw new ValidationError('HAR должен быть файлом не больше 128 МБ. Экспортируйте только нужные запросы Fetch/XHR.');
  let har;
  try {har = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));}
  catch {throw new ValidationError('Не удалось прочитать HAR как JSON.');}
  return inspectHar(har);
}

export function saveCapturedRequests(path, capture) {
  const requests = {};
  for (const {request, shape} of capture.candidates) {
    const safe = validateCapturedRequest(request);
    if (!safe.initial_page || !safe.headers.cookie || !shape.widget_count) continue;
    // Full page responses are preferred to individual widget fragments from the same page.
    if (!requests[safe.operation] || shape.widget_count > requests[safe.operation].widget_count) {
      requests[safe.operation] = {...safe, widget_count: shape.widget_count};
    }
  }
  if (!Object.keys(requests).length) throw new ValidationError('Не найдено пригодных запросов с Cookie и JSON страницы. Экспортируйте HAR с содержимым ответов и чувствительными заголовками.');
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ValidationError('Файл запросов Ozon не должен быть ссылкой.');
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify({version: 1, requests}, null, 2) + '\n', {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  renameSync(temporary, path);
  return Object.keys(requests);
}

export function loadCapturedRequest(path, operation) {
  let stored;
  try {stored = JSON.parse(readFileSync(path, 'utf8'));}
  catch {throw new ValidationError('Сначала импортируйте локальный HAR Ozon.');}
  if (stored?.version !== 1 || !Object.hasOwn(stored.requests || {}, operation)) throw new ValidationError('В HAR нет запроса для выбранного списка.');
  const request = validateCapturedRequest(stored.requests[operation]);
  if (request.operation !== operation || !request.initial_page || !request.headers.cookie) throw invalid();
  return request;
}
