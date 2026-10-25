import {createServer} from 'node:http';
import {readFileSync, realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join, resolve, sep} from 'node:path';
import {CONTEXTS} from './database.js';
import {FetchError, ValidationError} from './errors.js';
import {loadAuthentication} from './auth.js';
import {LoginError} from './randewoo-login.js';
import {LamodaError} from './providers/lamoda/parser.js';
import {androidLaunchPage,androidLaunchScript} from './providers/lamoda/mobile-launch.js';

const publicDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
// Radix and Recharts apply measured styles at runtime; scripts remain restricted to local assets.
const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://captcha.randewoo.ru/assets/widget.js https://cdn.jsdelivr.net/npm/@cap.js/wasm@0.0.6/browser/; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.randewoo.ru https://ir.ozone.ru https://a.lmcdn.ru; connect-src 'self' https://captcha.randewoo.ru https://cdn.jsdelivr.net/npm/@cap.js/wasm@0.0.6/browser/; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

function send(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  if (!Buffer.isBuffer(body)) body = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  response.writeHead(status, {'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': policy, ...headers});
  response.end(body);
}

async function readJson(request,limit = 100000) {
  const length = request.headers['content-length'];
  if (length != null && (!/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > limit)) throw new ValidationError('Некорректный размер запроса');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ValidationError('Некорректный размер запроса');
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

export function makeServer(tracker, {onShutdown, testMode = false, auth = loadAuthentication(tracker.root), controlToken, ozon = null,lamoda = null,
  publicOrigin = process.env.PRICE_CHECKER_PUBLIC_ORIGIN} = {}) {
  const csrf = randomBytes(32).toString('base64url');
  let externalOrigin;
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ValidationError('PRICE_CHECKER_PUBLIC_ORIGIN должен быть HTTPS-адресом сайта без пути.');
    }
    externalOrigin = parsed.origin;
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) send(response, 500, {error: 'Не удалось выполнить действие'});
      else response.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('upgrade',(request,socket,head) => {
    try {
      const port = server.address().port;
      const origins = [`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(externalOrigin ? [externalOrigin] : [])];
      const hosts = origins.map(value => new URL(value).host);
      const session = auth?.session(request);
      const path = new URL(request.url,origins[0]).pathname;
      const login = path === '/api/providers/lamoda/login/view' ? lamoda?.login : path === '/api/providers/ozon/login/view' ? ozon?.login : null;
      if (!session || !hosts.includes(request.headers.host) || !origins.includes(request.headers.origin)
        || !login) throw Error('Forbidden');
      login.upgrade(request,socket,head,session.csrf);
    } catch {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
  });

  async function handle(request, response) {
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (externalOrigin) hosts.push(new URL(externalOrigin).host);
    if (!hosts.includes(request.headers.host)) return send(response, 403, {error: 'Недопустимый адрес приложения'});
    const url = new URL(request.url, 'http://127.0.0.1:' + port);
    const section = url.searchParams.get('list') ?? 'cart', context = url.searchParams.get('context') ?? 'public';
    const session = auth?.session(request), authenticated = !auth || Boolean(session);
    const token = session?.csrf || csrf;
    const secureCookie = Boolean(externalOrigin) || Boolean(request.socket.encrypted);
    const authState = () => ({required: Boolean(auth), authenticated, login: session?.login || null, csrf_token: token});
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return send(response, 200, {ok: true, runtime: 'node.js', timezone: 'Europe/Moscow'});
      }
      if (request.method === 'GET' && url.pathname === '/api/auth') return send(response, 200, authState());
      if (request.method === 'GET' && url.pathname === '/lamoda/android/open') {
        return send(response,200,androidLaunchPage,'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/lamoda/android/launch.js') {
        return send(response,200,androidLaunchScript,'text/javascript; charset=utf-8');
      }
      if (url.pathname.startsWith('/api/lamoda-desktop/')) {
        if (!lamoda?.desktop) return send(response,503,{error:'Сбор Lamoda на ПК недоступен.'});
        if (request.headers.origin) {request.resume();return send(response,403,{error:'Используйте программу для ПК.'});}
        const action = url.pathname.slice('/api/lamoda-desktop/'.length);
        if (!(action === 'pair' && request.method === 'POST') && !lamoda.desktop.authenticate(request.headers.authorization)) {
          request.resume();return send(response,401,{error:'Подключите ПК заново.'});
        }
        if (request.method === 'GET' && action === 'config') {
          const pause = Math.max(Date.parse(lamoda.db.state().not_before)||0,Date.parse(lamoda.desktop.notBefore())||0);
          return send(response,200,{account_digest:lamoda.db.accountDigest(),server_time:new Date(lamoda.current()).toISOString(),mode:'staging',
            schedule:lamoda.desktop.schedule(),not_before:pause ? new Date(pause).toISOString() : null});
        }
        if (request.method === 'GET' && action === 'job') return send(response,200,{job:lamoda.desktop.getJob(url.searchParams.get('id'))});
        if (request.method !== 'POST') {request.resume();return send(response,405,{error:'Метод не поддерживается.'});}
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          request.resume();return send(response,415,{error:'Ожидается JSON.'});
        }
        const input = await readJson(request,action === 'snapshot' ? 16*1024*1024 : 4096);
        if (action === 'pair') return send(response,200,lamoda.desktop.pair(input.code,input.name));
        if (action === 'start') return send(response,200,{job:lamoda.desktop.start({scheduled:input.scheduled === true})});
        if (action === 'fail') return send(response,200,lamoda.desktop.fail(input.job_id,input));
        if (action === 'snapshot') return send(response,200,await lamoda.desktop.recordJob(input.job_id,input.run_id,input.pages));
        return send(response,404,{error:'Действие ПК не найдено.'});
      }
      if (url.pathname.startsWith('/api/lamoda-mobile/')) {
        if (!lamoda?.mobile) return send(response,503,{error:'Сбор через Android недоступен.'});
        // Native clients use a scoped device token, never browser cookies or CSRF exemptions for other APIs.
        if (request.headers.origin) {request.resume();return send(response,403,{error:'Используйте Android-приложение.'});}
        const action = url.pathname.slice('/api/lamoda-mobile/'.length);
        if (!(action === 'pair' && request.method === 'POST') && !lamoda.mobile.authenticate(request.headers.authorization)) {
          request.resume();return send(response,401,{error:'Подключите Android заново.'});
        }
        // Existing Android clients retry 5xx responses, but treat job:null as
        // successful completion. Keep a queued request retryable until admitted.
        const mobileJob = () => {
          if (lamoda.collectionQueue.status('lamoda').queued)
            return send(response,503,{error:'Проверка Lamoda ожидает в общей очереди.'},'application/json; charset=utf-8',{'Retry-After':'5'});
          const job = lamoda.mobile.next();
          const state = value => value === 'true' ? 1 : value === 'false' ? 0 : null;
          lamoda.mobile.contact(job?.id,{screenLocked:state(request.headers['x-screen-locked']),screenOff:state(request.headers['x-screen-off'])});
          return send(response,200,{job});
        };
        if (request.method === 'GET' && action === 'next') return mobileJob();
        if (request.method !== 'POST') {request.resume();return send(response,405,{error:'Метод не поддерживается.'});}
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {request.resume();return send(response,415,{error:'Ожидается JSON.'});}
        const input = await readJson(request,action === 'page' ? 2*1024*1024 : action === 'push' ? 8192 : 4096);
        if (action === 'pair') return send(response,200,lamoda.mobile.pair(input.code,input.name));
        if (action === 'push') return send(response,200,lamoda.push.register(input));
        if (action === 'stop') return send(response,200,await lamoda.stopMobile(input.job_id));
        if (action === 'start') {
          if (!lamoda.running) await lamoda.start({trigger:'android'});
          return mobileJob();
        }
        if (action === 'page') {
          try {return send(response,200,await lamoda.mobile.accept(input.job_id,input.page,input.user,input.payload));}
          catch (error) {
            if (error instanceof LamodaError) {try {lamoda.mobile.fail(input.job_id,error.code);} catch { /* Invalid or expired job. */ }}
            throw error;
          }
        }
        if (action === 'fail') {lamoda.mobile.fail(input.job_id,input.code,input.retry_after_ms,input.http_status);return send(response,200,{ok:true});}
        return send(response,404,{error:'Действие не найдено.'});
      }
      // Windows stop.cmd uses a local control token, independently of browser login.
      if (request.method === 'POST' && url.pathname === '/api/shutdown' && controlToken
        && request.headers.authorization === 'Bearer ' + controlToken && onShutdown) {
        request.resume();
        response.once('finish', onShutdown);
        return send(response, 200, {ok: true});
      }
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/login' && !authenticated) {
        request.resume();
        return send(response, 401, {error: 'Войдите в Price Checker'});
      }
      if (request.method === 'GET') {
        if (url.pathname.startsWith('/api/providers/lamoda/')) {
          if (url.pathname === '/api/providers/lamoda/status') return send(response,200,{...(lamoda ? lamoda.status() : {available:false,configured:false,message:'Раздел Lamoda временно недоступен.'}),csrf_token:token});
          if (!lamoda) return send(response,503,{error:'Раздел Lamoda временно недоступен.'});
          if (url.pathname === '/api/providers/lamoda/desktop/status') return send(response,200,lamoda.desktop.status());
          if (url.pathname === '/api/providers/lamoda/desktop/dashboard') return send(response,200,lamoda.desktop.dashboard());
          const desktopProduct = /^\/api\/providers\/lamoda\/desktop\/product\/(lamoda:item:[A-Z0-9]{6,32})\/history$/.exec(decodeURIComponent(url.pathname));
          if (desktopProduct) {
            const days = url.searchParams.get('days') ?? '30';
            if (!['0','7','30','90','365'].includes(days)) throw new ValidationError('Некорректный период Lamoda.');
            return send(response,200,lamoda.desktop.detail(desktopProduct[1],Number(days)));
          }
          if (url.pathname === '/api/providers/lamoda/login/status') return send(response,200,lamoda.login.status());
          if (url.pathname.startsWith('/api/providers/lamoda/login/assets/')) {
            if (!auth || !session) return send(response,403,{error:'Войдите в Price Checker'});
            const relative = url.pathname.slice('/api/providers/lamoda/login/assets/'.length);
            if (!/^[A-Za-z0-9_./-]+\.js$/.test(relative) || relative.split('/').includes('..')) return send(response,404,{error:'Файл не найден'});
            const directory = realpathSync(process.env.PRICE_CHECKER_NOVNC_PATH || '/opt/price-checker-ozon-remote/extracted/usr/share/novnc');
            const path = realpathSync(resolve(directory,relative));
            if (!path.startsWith(directory+sep)) return send(response,404,{error:'Файл не найден'});
            return send(response,200,readFileSync(path),'text/javascript; charset=utf-8');
          }
          if (url.pathname === '/api/providers/lamoda/dashboard') return send(response,200,{...lamoda.db.publishedDashboard(),status:lamoda.status()});
          const product = /^\/api\/providers\/lamoda\/product\/(lamoda:item:[A-Z0-9]{6,32})\/history$/.exec(decodeURIComponent(url.pathname));
          if (product) {
            const days = url.searchParams.get('days') ?? '30';
            if (!['0','7','30','90','365'].includes(days)) throw new ValidationError('Некорректный период Lamoda.');
            return send(response,200,lamoda.db.publishedDetail(product[1],Number(days)));
          }
          return send(response,404,{error:'Страница Lamoda не найдена'});
        }
        if (url.pathname === '/api/providers/ozon/login/status') return send(response,200,ozon?.login?.status() || {available:false,active:false,required:false});
        if (url.pathname.startsWith('/api/providers/ozon/login/assets/')) {
          const relative = url.pathname.slice('/api/providers/ozon/login/assets/'.length);
          if (!/^[A-Za-z0-9_./-]+\.js$/.test(relative) || relative.split('/').includes('..')) return send(response,404,{error:'Файл не найден'});
          const directory = realpathSync(process.env.PRICE_CHECKER_OZON_NOVNC_PATH || '/opt/price-checker-ozon-remote/extracted/usr/share/novnc');
          const path = realpathSync(resolve(directory,relative));
          if (!path.startsWith(directory+sep)) return send(response,404,{error:'Файл не найден'});
          return send(response,200,readFileSync(path),'text/javascript; charset=utf-8');
        }
        if (url.pathname === '/api/providers/ozon/status') return send(response,200,{...(ozon ? ozon.status() : {available:false,configured:false,message:'Раздел Ozon временно недоступен.'}),csrf_token:token});
        if (url.pathname.startsWith('/api/providers/ozon/')) {
          if (!ozon) return send(response,503,{error:'Раздел Ozon временно недоступен.'});
          if (url.pathname === '/api/providers/ozon/browser') {
            if (!auth || !session) return send(response,403,{error:'Для просмотра браузера войдите в Price Checker.'});
            return send(response,200,await ozon.browserStatus());
          }
          if (url.pathname === '/api/providers/ozon/dashboard') return send(response,200,{...ozon.db.publishedDashboard(url.searchParams.get('list') || 'favorites'),status:ozon.status()});
          const product = /^\/api\/providers\/ozon\/product\/(ozon:item:[1-9]\d{0,19})\/history$/.exec(decodeURIComponent(url.pathname));
          if (product) {
            const days = url.searchParams.get('days') ?? '30';
            if (!['0','7','30','90','365'].includes(days)) throw new ValidationError('Некорректный период Ozon.');
            return send(response,200,ozon.db.publishedDetail(product[1],Number(days)));
          }
          return send(response,404,{error:'Страница Ozon не найдена'});
        }
        if (url.pathname === '/api/status') return send(response, 200, {...tracker.status(), csrf_token: token});
        if (url.pathname === '/api/dashboard') return send(response, 200, {...tracker.db.publishedDashboard(section, context), status: tracker.status()});
        if (url.pathname.startsWith('/api/product/')) {
          const idText = url.pathname.slice('/api/product/'.length), days = url.searchParams.get('days') ?? '30';
          if (!/^\d+$/.test(idText) || !Number.isSafeInteger(Number(idText)) || !['0', '7', '30', '90', '365'].includes(days)) throw new ValidationError('Некорректный товар или период');
          return send(response, 200, tracker.db.publishedDetail(Number(idText), context, Number(days)));
        }
        if (url.pathname === '/api/export') return send(response, 200, exportCsv(tracker.db.rows(section, context), context), 'text/csv; charset=utf-8',
          {'Content-Disposition': `attachment; filename="prices-${section}-${context}.csv"`});
        if (url.pathname === '/favicon.ico') return send(response, 204, Buffer.alloc(0), 'image/x-icon');
        const page = ['/', '/cart', '/my-cart', '/favorites', '/watching', '/ozon', '/ozon/login','/ozon/browser','/lamoda','/lamoda/login','/lamoda/android'].includes(url.pathname.replace(/\/$/, '') || '/');
        const asset = /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?|svg)$/.exec(url.pathname);
        if (page || asset) {
          const filename = page ? 'index.html' : url.pathname.slice(1);
          const type = page ? 'text/html; charset=utf-8' : ({js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml'})[asset[1]];
          let body = readFileSync(join(publicDirectory, filename));
          if (testMode && filename === 'index.html') body = body.toString('utf8')
            .replace('<title>', '<title>ТЕСТ · ')
            .replace('name="price-checker-test-mode" content="false"', 'name="price-checker-test-mode" content="true"')
            .replace('<div id="root"></div>', '<div id="root"><div id="test-mode-banner">ТЕСТОВЫЙ РЕЖИМ · Загрузка приложения…</div></div>');
          const websocketOrigin = externalOrigin ? externalOrigin.replace(/^https:/,'wss:') : 'ws://'+request.headers.host;
          // noVNC decodes compressed framebuffer rectangles through data: images.
          const pagePolicy = policy.replace("connect-src 'self'","connect-src 'self' "+websocketOrigin)
            .replace("img-src 'self'","img-src 'self' data:");
          return send(response, 200, body, type,{'Content-Security-Policy':pagePolicy});
        }
        return send(response, 404, {error: 'Страница не найдена'});
      }
      if (request.method !== 'POST') return send(response, 405, {error: 'Метод не поддерживается'}, undefined, {Allow: 'GET, POST'});
      const origin = request.headers.origin;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(externalOrigin ? [externalOrigin] : [])];
      if ((origin && !origins.includes(origin)) || request.headers['x-csrf-token'] !== token) {
        request.resume();
        return send(response, 403, {error: 'Обновите страницу приложения и повторите действие'});
      }
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {request.resume(); return send(response, 415, {error: 'Ожидается JSON'});}
      const data = await readJson(request);
      if (url.pathname.startsWith('/api/providers/lamoda/')) {
        if (!lamoda) return send(response,503,{error:'Раздел Lamoda временно недоступен.'});
        if (['/api/providers/lamoda/desktop/pairing','/api/providers/lamoda/desktop/revoke'].includes(url.pathname)) {
          if (!auth || !session) return send(response,403,{error:'Войдите в Price Checker.'});
          if (url.pathname.endsWith('/pairing')) return send(response,200,lamoda.desktop.pairing());
          await lamoda.desktop.revoke();return send(response,200,{ok:true});
        }
        if (url.pathname === '/api/providers/lamoda/desktop/schedule') {
          if (!auth || !session) return send(response,403,{error:'Войдите в Price Checker.'});
          return send(response,200,lamoda.desktop.setSchedule(data.enabled));
        }
        if (['/api/providers/lamoda/mobile/pairing','/api/providers/lamoda/mobile/connect','/api/providers/lamoda/mobile/revoke'].includes(url.pathname)) {
          if (!auth || !session) return send(response,403,{error:'Войдите в Price Checker.'});
          if (url.pathname.endsWith('/connect')) {
            const invite = lamoda.mobile.pairing();
            return send(response,200,{url:'/lamoda/android/open#connect='+invite.code,expires_at:invite.expires_at});
          }
          if (url.pathname.endsWith('/pairing')) return send(response,200,lamoda.mobile.pairing());
          lamoda.mobile.revoke();return send(response,200,{ok:true});
        }
        if (url.pathname.startsWith('/api/providers/lamoda/login/')) {
          if (!auth || !session) return send(response,403,{error:'Войдите в Price Checker'});
          if (url.pathname === '/api/providers/lamoda/login/start') return send(response,200,await lamoda.login.start(token));
          if (url.pathname === '/api/providers/lamoda/login/finish') return send(response,200,await lamoda.login.finish(token));
          if (url.pathname === '/api/providers/lamoda/login/cancel') {await lamoda.login.cancel(token);return send(response,200,{ok:true});}
        }
        if (url.pathname === '/api/providers/lamoda/refresh') {
          if (data.id != null) throw new ValidationError('Lamoda обновляется целиком из избранного.');
          return send(response,202,await lamoda.start());
        }
        if (url.pathname === '/api/providers/lamoda/settings') {lamoda.settings(data);return send(response,200,{ok:true});}
        return send(response,404,{error:'Действие Lamoda не найдено'});
      }
      if (url.pathname.startsWith('/api/providers/ozon/')) {
        if (!ozon) return send(response,503,{error:'Раздел Ozon временно недоступен.'});
        if (url.pathname.startsWith('/api/providers/ozon/login/')) {
          if (!auth || !session || !ozon.login) return send(response,403,{error:'Войдите в Price Checker'});
          if (url.pathname === '/api/providers/ozon/login/start') return send(response,200,await ozon.login.start(token));
          if (url.pathname === '/api/providers/ozon/login/phone') return send(response,200,await ozon.login.fillPhone(token));
          if (url.pathname === '/api/providers/ozon/login/finish') return send(response,200,await ozon.login.finish(token));
          if (url.pathname === '/api/providers/ozon/login/cancel') {await ozon.login.cancel(token);return send(response,200,{ok:true});}
        }
        if (url.pathname === '/api/providers/ozon/watch/add') return send(response,200,{id:ozon.watch(data.url)});
        if (url.pathname === '/api/providers/ozon/watch/remove') {ozon.unwatch(data.id); return send(response,200,{ok:true});}
        if (url.pathname === '/api/providers/ozon/refresh') {
          if (data.id != null && typeof data.id !== 'string') throw new ValidationError('Некорректный товар Ozon.');
          return send(response,202,await ozon.start({id:data.id ?? null}));
        }
        if (url.pathname === '/api/providers/ozon/settings') {ozon.settings(data); return send(response,200,{ok:true});}
        return send(response,404,{error:'Действие Ozon не найдено'});
      }
      if (url.pathname === '/api/login' && auth) {
        const result = await auth.login(data.login, data.password, request.socket.remoteAddress);
        if (result.status !== 200) return send(response, result.status, {error: result.error}, undefined,
          result.status === 429 ? {'Retry-After': '900'} : {});
        auth.logout(request);
        return send(response, 200, {required: true, authenticated: true, login: result.session.login, csrf_token: result.session.csrf}, undefined,
          {'Set-Cookie': auth.cookie(result.token, secureCookie)});
      }
      if (url.pathname === '/api/logout' && auth) {
        tracker.randewooLogin.cancel(token);
        if (ozon?.login?.session?.owner === token || ozon?.login?.opening?.owner === token) await ozon.login.cancel(token);
        if (lamoda?.login?.session?.owner === token) await lamoda.login.cancel(token);
        auth.logout(request);
        return send(response, 200, {required: true, authenticated: false, login: null, csrf_token: csrf}, undefined,
          {'Set-Cookie': auth.cookie('', secureCookie)});
      }
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
      if (url.pathname === '/api/randewoo/prepare') return send(response, 200, await tracker.randewooLogin.prepare(token));
      if (url.pathname === '/api/randewoo/send-code') return send(response, 200, await tracker.randewooLogin.send(token, data));
      if (url.pathname === '/api/randewoo/confirm') return send(response, 200, await tracker.randewooLogin.confirm(token, data));
      if (url.pathname === '/api/randewoo/cancel') {
        if (typeof data.challenge_id !== 'string') throw new ValidationError('Укажите подключение для отмены');
        tracker.randewooLogin.cancel(token, data.challenge_id);
        return send(response, 200, {ok: true});
      }
      if (url.pathname === '/api/shutdown' && onShutdown) {
        response.once('finish', onShutdown);
        return send(response, 200, {ok: true});
      }
      return send(response, 404, {error: 'Действие не найдено'});
    } catch (error) {
      if (error.code === 'ENOENT') return send(response, 404, {error: 'Страница не найдена'});
      if (error instanceof LoginError) return send(response, error.status, {error: error.message});
      if (error instanceof ValidationError) return send(response, 400, {error: error.message});
      if (error instanceof LamodaError) return send(response,400,{error:error.message,code:error.code});
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
