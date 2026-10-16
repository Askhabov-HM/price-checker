import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {CONTEXTS} from './database.js';
import {FetchError, ValidationError} from './errors.js';

const publicDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
// Radix and Recharts apply measured styles at runtime; scripts remain restricted to local assets.
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.randewoo.ru; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

function send(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  if (!Buffer.isBuffer(body)) body = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  response.writeHead(status, {'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': policy, ...headers});
  response.end(body);
}

async function readJson(request) {
  const length = request.headers['content-length'];
  if (length != null && (!/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > 100000)) throw new ValidationError('Некорректный размер запроса');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100000) throw new ValidationError('Некорректный размер запроса');
    chunks.push(chunk);
  }
  let data;
  try {data = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new ValidationError('Некорректный JSON');}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Некорректный запрос');
  return data;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
  return /[;"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
const decimal = value => value == null ? '' : (value < 0 ? '-' : '') + Math.floor(Math.abs(value) / 100) + ',' + String(Math.abs(value) % 100).padStart(2, '0');

export function exportCsv(rows, context) {
  const statuses = {ok: 'Успешно', error: 'Ошибка проверки', missing: 'Вариант отсутствует', pending: 'Ожидает проверки'};
  const lines = [['Бренд', 'Товар', 'Вариант', 'Артикул', 'Цена, руб.', 'Изменение, руб.', 'Наличие', 'Проверено UTC', 'Тип цены', 'Ссылка', 'Статус проверки', 'Цена получена UTC', 'Сообщение'].join(';')];
  for (const row of rows) {
    const stock = row.status === 'missing' ? 'Нет' : row.status === 'ok' && row.in_stock != null ? row.in_stock ? 'Да' : 'Нет' : 'Неизвестно';
    lines.push([csvCell(row.brand), csvCell(row.name), csvCell(row.label), csvCell(row.sku), decimal(row.price), decimal(row.delta),
      stock, row.checked_at || '', CONTEXTS[context], csvCell(row.url), statuses[row.status] || statuses.pending,
      row.price_at || '', csvCell(row.message)].join(';'));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

export function makeServer(tracker, {onShutdown, testMode = false} = {}) {
  const csrf = randomBytes(32).toString('base64url');
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) send(response, 500, {error: 'Не удалось выполнить действие'});
      else response.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  async function handle(request, response) {
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host)) return send(response, 403, {error: 'Недопустимый адрес приложения'});
    const url = new URL(request.url, 'http://127.0.0.1:' + port);
    const section = url.searchParams.get('list') ?? 'cart', context = url.searchParams.get('context') ?? 'public';
    try {
      if (request.method === 'GET') {
        if (url.pathname === '/api/status') return send(response, 200, {...tracker.status(), csrf_token: csrf});
        if (url.pathname === '/api/dashboard') return send(response, 200, {items: tracker.db.rows(section, context), counts: tracker.db.counts(), list: section, context,
          history: tracker.db.listHistory(section, context), status: tracker.status()});
        if (url.pathname.startsWith('/api/product/')) {
          const idText = url.pathname.slice('/api/product/'.length), days = url.searchParams.get('days') ?? '30';
          if (!/^\d+$/.test(idText) || !Number.isSafeInteger(Number(idText)) || !['0', '7', '30', '90', '365'].includes(days)) throw new ValidationError('Некорректный товар или период');
          return send(response, 200, tracker.db.detail(Number(idText), context, Number(days)));
        }
        if (url.pathname === '/api/export') return send(response, 200, exportCsv(tracker.db.rows(section, context), context), 'text/csv; charset=utf-8',
          {'Content-Disposition': `attachment; filename="prices-${section}-${context}.csv"`});
        if (url.pathname === '/favicon.ico') return send(response, 204, Buffer.alloc(0), 'image/x-icon');
        const page = ['/', '/cart', '/my-cart', '/favorites', '/watching'].includes(url.pathname.replace(/\/$/, '') || '/');
        const asset = /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?|svg)$/.exec(url.pathname);
        if (page || asset) {
          const filename = page ? 'index.html' : url.pathname.slice(1);
          const type = page ? 'text/html; charset=utf-8' : ({js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml'})[asset[1]];
          let body = readFileSync(join(publicDirectory, filename));
          if (testMode && filename === 'index.html') body = body.toString('utf8')
            .replace('<title>', '<title>ТЕСТ · ')
            .replace('name="price-checker-test-mode" content="false"', 'name="price-checker-test-mode" content="true"')
            .replace('<div id="root"></div>', '<div id="root"><div id="test-mode-banner">ТЕСТОВЫЙ РЕЖИМ · Загрузка приложения…</div></div>');
          return send(response, 200, body, type);
        }
        return send(response, 404, {error: 'Страница не найдена'});
      }
      if (request.method !== 'POST') return send(response, 405, {error: 'Метод не поддерживается'}, undefined, {Allow: 'GET, POST'});
      const origin = request.headers.origin;
      if ((origin && !hosts.map(host => 'http://' + host).includes(origin)) || request.headers['x-csrf-token'] !== csrf) {
        request.resume();
        return send(response, 403, {error: 'Обновите страницу приложения и повторите действие'});
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {request.resume(); return send(response, 415, {error: 'Ожидается JSON'});}
      const data = await readJson(request);
      if (url.pathname === '/api/refresh') {
        if (!tracker.startRefresh()) return send(response, 409, {error: 'Проверка уже выполняется'});
        return send(response, 202, {started: true});
      }
      if (url.pathname === '/api/watch') {
        if (typeof data.active !== 'boolean' || !Number.isSafeInteger(data.id) || data.id < 1) throw new ValidationError('Некорректное действие');
        tracker.db.watch(data.id, data.active);
        return send(response, 200, {ok: true});
      }
      if (url.pathname === '/api/watch/add') return send(response, 200, {id: await tracker.addUrl(data.url)});
      if (url.pathname === '/api/my-cart') {
        if (typeof data.active !== 'boolean' || !Number.isSafeInteger(data.id) || data.id < 1) throw new ValidationError('Некорректное действие');
        tracker.db.personalCart(data.id, data.active);
        return send(response, 200, {ok: true});
      }
      if (url.pathname === '/api/my-cart/add') return send(response, 200, {id: await tracker.addUrl(data.url, 'my-cart')});
      if (url.pathname === '/api/settings') {tracker.saveSettings(data); return send(response, 200, {ok: true});}
      if (url.pathname === '/api/session') {tracker.saveSession(data); return send(response, 200, {ok: true});}
      if (url.pathname === '/api/shutdown' && onShutdown) {
        response.once('finish', onShutdown);
        return send(response, 200, {ok: true});
      }
      return send(response, 404, {error: 'Действие не найдено'});
    } catch (error) {
      if (error.code === 'ENOENT') return send(response, 404, {error: 'Страница не найдена'});
      if (error instanceof ValidationError) return send(response, 400, {error: error.message});
      if (error instanceof FetchError) return send(response, 502, {error: error.message});
      return send(response, 500, {error: 'Не удалось выполнить действие'});
    }
  }
  return server;
}

export function listen(server, port = 8000) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {server.off('error', failed); resolve(server.address().port);});
  });
}
