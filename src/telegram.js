import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseResponse, quote} from './randewoo-transport.js';
import {now} from './time.js';
import {CodexChat, CodexRunner} from './codex-chat.js';
import {ValidationError} from './errors.js';

const methods = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'setMyCommands']);
const labels = {success: 'Успешно', partial: 'Есть ошибки', error: 'Ошибка', interrupted: 'Прервана'};
const date = value => value ? new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short'}).format(new Date(value)) + ' МСК' : '—';
const reportDate = value => value ? new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(value)) + ' МСК' : '—';
const stores = {
  randewoo: {name: 'Randewoo', emoji: '🌸', id: '5382276449241703317', path: '/cart'},
  ozon: {name: 'Ozon', emoji: '😎', id: '5463148170869482726', path: '/ozon'},
  lamoda: {name: 'Lamoda',emoji:'🛍️',path:'/lamoda'},
};
const reportFormat = 'price-checker-telegram-v1';
const delayedAfterMs = 5 * 60 * 1000;
const short = (value, limit) => {
  const text = String(value).slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
};
const retryDelay = (error, attempts) => Math.max(Math.min(60000, 2000 * 2 ** Math.min(attempts, 5)), (error.retryAfter || 0) * 1000);

export class TelegramError extends Error {
  constructor(reason, code = null, retryAfter = 0) {
    super('Telegram: ' + reason);
    this.reason = reason; this.code = code; this.retryAfter = retryAfter;
  }
}

export class TelegramApi {
  constructor({token, proxy, spawnProcess = spawn}) {
    if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new TelegramError('configuration');
    if (proxy) {
      let url;
      try {url = new URL(proxy);} catch {throw new TelegramError('configuration');}
      if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.search || url.pathname !== '/') throw new TelegramError('configuration');
    }
    this.token = token; this.proxy = proxy; this.spawnProcess = spawnProcess;
    this.children = new Set(); this.closed = false;
  }

  async call(method, data = {}) {
    if (!methods.has(method)) throw new TelegramError('method');
    if (this.closed) throw new TelegramError('stopped');
    const config = ['url = ' + quote(`https://api.telegram.org/bot${this.token}/${method}`), 'silent', 'show-error',
      'request = "POST"', 'proto = "=https"', 'connect-timeout = 10', 'max-time = 35',
      'header = "Content-Type: application/json"', 'data = ' + quote(JSON.stringify(data)),
      'write-out = "\\nPRICE_CHECKER_STATUS:%{http_code}"'];
    // Keep the proxy specific to Telegram; Randewoo does not inherit it.
    if (this.proxy) config.push('proxy = ' + quote(this.proxy), 'noproxy = ""');
    else config.push('noproxy = "*"');
    const output = await new Promise((resolve, reject) => {
      const child = this.spawnProcess(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-q', '--config', '-'],
        {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      this.children.add(child);
      let settled = false, size = 0;
      const chunks = [];
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.children.delete(child);
        if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const timer = setTimeout(() => {child.kill(); finish(new TelegramError('timeout'));}, 40000);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {child.kill(); finish(new TelegramError('response_too_large'));}
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => finish(new TelegramError('transport')));
      child.on('close', code => finish(this.closed ? new TelegramError('stopped') : code ? new TelegramError('transport') : null));
      child.stdin.end(config.join('\n'));
    });
    const {status, payload} = parseResponse(output);
    let response;
    try {response = JSON.parse(payload);} catch {throw new TelegramError('invalid_response', status);}
    if (status !== 200 || response?.ok !== true) {
      const retryAfter = response?.parameters?.retry_after;
      throw new TelegramError('request', Number.isInteger(response?.error_code) ? response.error_code : status,
        Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400 ? retryAfter : 0);
    }
    return response.result;
  }

  close() {this.closed = true; for (const child of this.children) child.kill();}
}

function randewooChanges(db, check) {
  return db.all(`SELECT current.price,
    (SELECT old.price FROM observations old WHERE old.variant_id=current.variant_id AND old.context=current.context
      AND old.id<current.id AND (old.check_id IS NULL OR old.check_id!=current.check_id)
      AND old.status='ok' AND old.price IS NOT NULL ORDER BY old.id DESC LIMIT 1) AS previous_price
    FROM observations current
    WHERE current.check_id=? AND current.status='ok' AND current.price IS NOT NULL
      AND current.in_stock IS NOT 0
      AND current.id=(SELECT MAX(last.id) FROM observations last WHERE last.check_id=current.check_id
        AND last.variant_id=current.variant_id AND last.context=current.context)`, check.id)
    .filter(row => row.previous_price != null && row.previous_price !== row.price);
}

function ozonChanges(db, check) {
  return db.db.prepare(`SELECT current.listed_price_kopecks AS price,
    (SELECT old.listed_price_kopecks FROM observations old WHERE old.sku=current.sku AND old.id<current.id
      AND old.check_id!=current.check_id AND old.status='ok' AND old.listed_price_kopecks IS NOT NULL
      ORDER BY old.id DESC LIMIT 1) AS previous_price
    FROM observations current
    WHERE current.check_id=? AND current.status='ok' AND current.listed_price_kopecks IS NOT NULL
      AND (current.availability IS NULL OR current.availability NOT IN ('out_of_stock','unavailable'))
      AND current.id=(SELECT MAX(last.id) FROM observations last
        WHERE last.check_id=current.check_id AND last.sku=current.sku)`).all(check.id)
    .filter(row => row.previous_price != null && row.previous_price !== row.price);
}

function outcome(store, check) {
  if (check.status === 'success') return {kind: 'success', icon: '✅'};
  if (check.status === 'interrupted') return {kind: 'interrupted', icon: '⏹', message: 'Проверка прервана.'};
  const message = check.message || '';
  const login = store === 'ozon' ? /Нужно обновить вход в Ozon\./.test(message)
    : /Сессия истекла: обновите вход в Randewoo|Добавьте действующую сессию Randewoo/.test(message);
  if (login) return {kind: 'login', icon: '🔐', message: 'Требуется повторный вход в аккаунт.'};
  if (check.status === 'partial') return {kind: 'partial', icon: '⚠️', message: 'Часть данных не удалось получить.'};
  if (/ограничил доступ|снизить частоту|слишком много запросов|пауза.*Ozon/i.test(message)) {
    return {kind: 'limited', icon: '🔴', message: store === 'ozon'
      ? 'Магазин временно ограничил доступ. Следующая попытка — по расписанию с учётом паузы источника.'
      : 'Магазин ограничил доступ. Проверка приостановлена.'};
  }
  return {kind: 'error', icon: '🔴', message: 'Не удалось выполнить проверку.'};
}

function report(store, check, changes, previous = null) {
  const state = outcome(store, check), logo = stores[store];
  const reason = state.kind === 'success' ? null : createHash('sha256')
    .update(String(check.message || '').replace(/\d+/g, '#')).digest('hex');
  const down = changes.filter(row => row.price < row.previous_price).length;
  const up = changes.filter(row => row.price > row.previous_price).length;
  const recovered = state.kind === 'success' && previous && previous.kind !== 'success';
  const lines = [`${state.icon} ${logo.emoji} ${logo.name} · ${reportDate(check.finished_at)}`, ''];
  if (state.message) lines.push(state.message);
  if (recovered) lines.push('Проверка снова работает.');
  if (['success', 'partial'].includes(state.kind)) {
    if (state.message || recovered) lines.push('');
    if (down || up || state.kind === 'partial') lines.push(`📉 Снижений: ${down}`, `📈 Повышений: ${up}`);
    else lines.push('Изменений цен нет.');
  }
  return {format: reportFormat, store, kind: state.kind, reason, down, up,
    finishedAt: check.finished_at, text: lines.join('\n')};
}

export function checkMessage(db, check) {return report('randewoo', check, randewooChanges(db, check)).text;}
export function ozonCheckMessage(db, check) {return report('ozon', check, ozonChanges(db, check)).text;}

function publicSite(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {throw new TelegramError('configuration');}
}

export class TelegramBot {
  constructor(tracker, {api, ownerId, codexRunner, ozon, lamoda,publicOrigin = process.env.PRICE_CHECKER_PUBLIC_ORIGIN,
    logger = entry => console.info(JSON.stringify(entry)), sleep = delay} = {}) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new TelegramError('configuration');
    this.tracker = tracker; this.ozon = ozon;this.lamoda = lamoda; this.db = tracker.db; this.api = api; this.ownerId = ownerId;
    this.logger = logger; this.sleep = sleep; this.abort = new AbortController();
    this.publicOrigin = publicSite(publicOrigin);
    this.cursorKey = `telegram_check_cursor:${ownerId}`;
    this.offsetKey = `telegram_offset:${ownerId}`;
    this.db.run(`CREATE TABLE IF NOT EXISTS telegram_outbox(
      check_id INTEGER NOT NULL REFERENCES checks(id),owner_id INTEGER NOT NULL,text TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,
      PRIMARY KEY(check_id,owner_id))`);
    if (this.db.setting(this.cursorKey) == null) {
      const latest = this.db.checks(1)[0];
      this.db.setSetting(this.cursorKey, latest ? latest.id - (latest.status === 'running' ? 1 : 0) : 0);
    }
    if (ozon) {
      this.ozonCursorKey = `telegram_ozon_check_cursor:${ownerId}`;
      // Ozon check IDs belong to a separate database and cannot reference Randewoo checks.
      this.db.run(`CREATE TABLE IF NOT EXISTS telegram_ozon_outbox(
        check_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,
        PRIMARY KEY(check_id,owner_id))`);
      if (this.db.setting(this.ozonCursorKey) == null) {
        const latest = ozon.db.checks()[0];
        this.db.setSetting(this.ozonCursorKey, latest ? latest.id - (latest.status === 'running' ? 1 : 0) : 0);
      }
    }
    for (const store of ['randewoo', ...(ozon ? ['ozon'] : [])]) {
      const key = this.reportStateKey(store);
      if (this.db.setting(key) == null) {
        const cursor = this.db.setting(store === 'ozon' ? this.ozonCursorKey : this.cursorKey, 0);
        const check = store === 'ozon'
          ? ozon.db.db.prepare("SELECT * FROM checks WHERE id<=? AND finished_at IS NOT NULL AND status!='imported' ORDER BY id DESC LIMIT 1").get(cursor)
          : this.db.get("SELECT * FROM checks WHERE id<=? AND finished_at IS NOT NULL AND status!='imported' ORDER BY id DESC LIMIT 1", cursor);
        if (check) this.db.setSetting(key, {kind: outcome(store, check).kind, announced: false});
      }
    }
    if (codexRunner) this.chat = new CodexChat(this.db, {runner: codexRunner, ownerId, send: text => this.send(text, {service: false}), logger});
  }

  reportStateKey(store) {return `telegram_report_state:${store}:${this.ownerId}`;}

  enqueueReport(store, check) {
    if (check.status === 'imported') return;
    const previous = this.db.setting(this.reportStateKey(store));
    const changes = store === 'ozon' ? ozonChanges(this.ozon.db, check) : randewooChanges(this.db, check);
    const payload = report(store, check, changes, previous);
    // Keep useful partial price results, while silencing an unchanged failure.
    if (payload.kind === 'success' || !previous?.announced || payload.kind !== previous.kind
      || payload.reason !== previous.reason || payload.down || payload.up) {
      const table = store === 'ozon' ? 'telegram_ozon_outbox' : 'telegram_outbox';
      this.db.run(`INSERT OR IGNORE INTO ${table}(check_id,owner_id,text) VALUES(?,?,?)`,
        check.id, this.ownerId, JSON.stringify(payload));
    }
    this.db.setSetting(this.reportStateKey(store), {kind: payload.kind, reason: payload.reason, announced: true});
  }

  log(event, error) {
    // Never record raw API responses, message text, URLs, tokens or stderr.
    this.logger({time: now(), event, ...(error ? {reason: error instanceof TelegramError ? error.reason : 'internal',
      code: error instanceof TelegramError ? error.code : null} : {})});
  }

  discoverChecks() {
    const checks = this.db.all("SELECT * FROM checks WHERE id>? AND finished_at IS NOT NULL AND status!='running' ORDER BY id",
      this.db.setting(this.cursorKey, 0));
    for (const check of checks) {
      // The collector can still be saving its backup after setting finished_at.
      // Wait for its final outcome, including a possible backup error.
      if (check.id === this.tracker.client.checkId) break;
      this.db.transaction(() => {
        this.enqueueReport('randewoo', check);
        this.db.setSetting(this.cursorKey, check.id);
      });
    }
    if (this.ozon && !this.ozon.running) {
      const checks = this.ozon.db.db.prepare("SELECT * FROM checks WHERE id>? AND finished_at IS NOT NULL AND status!='running' ORDER BY id")
        .all(this.db.setting(this.ozonCursorKey, 0));
      for (const check of checks) {
        this.db.transaction(() => {
          this.enqueueReport('ozon', check);
          this.db.setSetting(this.ozonCursorKey, check.id);
        });
      }
    }
  }

  deliverPending() {
    if (!this.deliveryPromise) this.deliveryPromise = (async () => {
      for (const table of ['telegram_outbox', ...(this.ozon ? ['telegram_ozon_outbox'] : [])]) {
        while (!this.abort.signal.aborted) {
          const row = this.db.get(`SELECT * FROM ${table} WHERE owner_id=? AND delivered_at IS NULL AND next_attempt_ms<=? ORDER BY check_id LIMIT 1`, this.ownerId, Date.now());
          if (!row) break;
          try {
            let payload;
            try {payload = JSON.parse(row.text);} catch { /* Upgrade an older queued report without losing it. */ }
            if (payload?.format !== reportFormat) {
              const store = table === 'telegram_ozon_outbox' ? 'ozon' : 'randewoo';
              const check = store === 'ozon' ? this.ozon.db.db.prepare('SELECT * FROM checks WHERE id=?').get(row.check_id)
                : this.db.get('SELECT * FROM checks WHERE id=?', row.check_id);
              if (!check) throw new TelegramError('missing_check');
              payload = report(store, check, store === 'ozon' ? ozonChanges(this.ozon.db, check) : randewooChanges(this.db, check));
              this.db.run(`UPDATE ${table} SET text=? WHERE check_id=? AND owner_id=?`, JSON.stringify(payload), row.check_id, this.ownerId);
            }
            await this.send(payload);
            this.db.run(`UPDATE ${table} SET delivered_at=? WHERE check_id=? AND owner_id=?`, now(), row.check_id, this.ownerId);
            this.log('telegram_check_delivered');
          } catch (error) {
            if (!this.abort.signal.aborted) {
              this.db.run(`UPDATE ${table} SET attempts=attempts+1,next_attempt_ms=? WHERE check_id=? AND owner_id=?`,
                Date.now() + retryDelay(error, row.attempts), row.check_id, this.ownerId);
              this.log('telegram_delivery_failed', error);
            }
            break;
          }
        }
      }
    })().finally(() => {this.deliveryPromise = null;});
    return this.deliveryPromise;
  }

  send(value, {service = true} = {}) {
    const payload = value?.format === reportFormat ? value : null;
    let text = payload ? payload.text : String(value);
    if (payload?.finishedAt && Date.now() - Date.parse(payload.finishedAt) > delayedAfterMs) {
      text += '\n\n🕒 Отчёт доставлен с задержкой.';
    }
    if (payload) {
      const provider = payload.store === 'lamoda' ? this.lamoda : payload.store === 'ozon' ? this.ozon : this.tracker;
      const status = provider?.status?.();
      const next = status?.next_check;
      const time = status?.action_required ? 'требуется вход' : next
        ? new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'}).format(new Date(next))
        : 'не запланирована';
      const footer = '\n\nСледующая проверка: ' + time;
      text = short(text, 4000 - footer.length) + footer;
    } else text = short(text, 4000);
    const data = {chat_id: this.ownerId, text, link_preview_options: {is_disabled: true}};
    if (service) {
      const login = payload?.kind === 'login';
      const ozonLogin = login && payload.store === 'ozon';
      const lamodaLogin = login && payload.store === 'lamoda';
      const connect = payload?.store === 'lamoda' && payload.kind === 'android_connect' && /^[a-f0-9]{32}$/.test(payload.invitation);
      const mobile = payload?.store === 'lamoda' && (connect || payload.kind === 'android' || lamodaLogin && this.lamoda?.mobile?.enabled());
      const path = mobile ? '/lamoda/android/open' : lamodaLogin ? '/lamoda/login' : ozonLogin ? '/ozon/login' : stores[payload?.store]?.path || '';
      const url = this.publicOrigin + path + (connect ? '#connect='+payload.invitation : '');
      data.reply_markup = {inline_keyboard: [[{text: connect ? '📱 Подключить телефон' : mobile ? '📱 Открыть на Android' : lamodaLogin ? '🔐 Войти в Lamoda' : ozonLogin ? '🔐 Войти в Ozon'
        : login ? '🔐 Подключить Randewoo' : '🌐 Открыть сайт', url}]]};
      const entities = [];
      for (const logo of Object.values(stores)) {
        const offset = text.indexOf(`${logo.emoji} ${logo.name}`);
        if (offset < 0) continue;
        if (logo.id) entities.push({type: 'custom_emoji', offset, length: logo.emoji.length, custom_emoji_id: logo.id});
        const start = offset + logo.emoji.length + 1, end = text.indexOf('\n', start);
        entities.push({type: 'bold', offset: start, length: (end < 0 ? text.length : end) - start});
      }
      if (entities.length) data.entities = entities;
    }
    return this.api.call('sendMessage', data);
  }

  async notifyOzonLogin() {
    // The completed check and the login callback describe the same event.
    this.discoverChecks();
    await this.deliverPending();
    const key = this.reportStateKey('ozon');
    const previous = this.db.setting(key);
    if (previous?.kind === 'login' && previous.announced) return;
    const payload = report('ozon', {status: 'error', message: 'Нужно обновить вход в Ozon.', finished_at: now()}, []);
    await this.send(payload);
    this.db.setSetting(key, {kind: 'login', reason: payload.reason, announced: true});
  }

  async deliverLamoda() {
    if (!this.lamoda || this.lamodaDelivery) return this.lamodaDelivery;
    this.lamodaDelivery = (async () => {
      for (const row of this.lamoda.db.pending()) {
        if (this.abort.signal.aborted) break;
        try {
          const payload = JSON.parse(row.payload);
          const lines = [`${payload.kind === 'android' ? '📱' : payload.kind === 'success' ? '✅' : payload.kind === 'login' ? '🔐' : '🔴'} 🛍️ Lamoda · ${reportDate(payload.finishedAt)}`, ''];
          if (payload.kind === 'success') {
            if (payload.recovered) lines.push('Проверка снова работает.','');
            if (payload.down || payload.up) lines.push(`📉 Снижений: ${payload.down}`,`📈 Повышений: ${payload.up}`);
            else lines.push('Изменений цен нет.');
          } else if (payload.kind === 'android') lines.push('Откройте приложение на телефоне: избранное откроется и сбор начнётся автоматически.','Держите приложение открытым до завершения. На получение всех страниц отводится 10 минут с момента запуска задания.');
          else lines.push(payload.kind === 'login' ? 'Требуется повторный вход в аккаунт.' : 'Не удалось выполнить проверку.');
          const result = await this.send({...payload,format:reportFormat,text:lines.join('\n')});
          this.lamoda.db.delivered(row.event_id,result?.message_id,now());
        } catch(error) {
          this.lamoda.db.retry(row.event_id,Date.now()+retryDelay(error,row.attempts));this.log('telegram_lamoda_delivery_failed',error);break;
        }
      }
    })().finally(() => {this.lamodaDelivery = null;});
    return this.lamodaDelivery;
  }

  async handleUpdate(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < this.db.setting(this.offsetKey, 0)) return;
    const message = update.message;
    const allowed = message?.from?.id === this.ownerId && !message.from.is_bot && message.chat?.type === 'private'
      && message.chat.id === this.ownerId && typeof message.text === 'string';
    // Store the request and update offset together, before acknowledging it to Telegram.
    if (allowed && !message.text.startsWith('/') && this.chat) {
      let result;
      this.db.transaction(() => {
        result = this.chat.enqueue(update.update_id, message.text);
        this.db.setSetting(this.offsetKey, update.update_id + 1);
      });
      if (result === 'full') await this.send('В очереди уже 10 сообщений. Дождись ответов и отправь сообщение снова.');
      if (result === 'invalid') await this.send('Отправь непустое текстовое сообщение до 16 000 символов.');
      return;
    }
    // Persist before dispatch so a restart cannot repeat a collection command.
    this.db.setSetting(this.offsetKey, update.update_id + 1);
    if (!allowed) return;
    const command = /^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(message.text);
    if (command?.[2] && command[2].toLowerCase() !== this.username?.toLowerCase()) return;
    switch (command?.[1].toLowerCase()) {
      case 'check_randewoo': {
        const started = this.tracker.startRefresh('telegram');
        if (started) await this.tracker.refreshReady;
        await this.send(started ? this.tracker.status().queued
          ? '⏳ Проверка Randewoo поставлена в общую очередь. Результат придёт после завершения.'
          : '▶️ Проверка Randewoo запущена. Результат придёт после завершения.' : '⏳ Проверка Randewoo уже выполняется или приложение останавливается.');
        return;
      }
      case 'check_ozon': {
        if (!this.ozon) {await this.send('Проверка Ozon пока недоступна в приложении.'); return;}
        try {
          await this.ozon.start({trigger:'telegram'});
        } catch (error) {
          await this.send(error instanceof ValidationError ? `Ozon: ${error.message}` : 'Не удалось запустить проверку Ozon.');
          return;
        }
        await this.send(this.ozon.status().queued ? '⏳ Проверка Ozon поставлена в общую очередь. Результат придёт после завершения.'
          : '▶️ Проверка Ozon запущена. Результат придёт после завершения.');
        return;
      }
      case 'lamoda_android': {
        if (!this.lamoda?.mobile) {await this.send('Раздел Lamoda временно недоступен.');return;}
        const invite = this.lamoda.mobile.pairing();
        await this.send({format:reportFormat,store:'lamoda',kind:'android_connect',invitation:invite.code,
          text:'📱 🛍️ Lamoda\n\nНажмите «Подключить телефон» на Android с установленным Lamoda Collector. Ничего вводить не нужно.\nСсылка одноразовая и действует 10 минут. Она заменит прежнее подключение телефона. Не пересылайте её.'});
        return;
      }
      case 'check_lamoda': {
        if (!this.lamoda) {await this.send('Раздел Lamoda временно недоступен.');return;}
        try {await this.lamoda.start({trigger:'telegram'});await this.send(this.lamoda.status().queued
          ? '⏳ Проверка Lamoda поставлена в общую очередь. Результат придёт после завершения.'
          : '▶️ Проверка Lamoda запущена. Результат придёт после завершения.');}
        catch(error) {await this.send(error instanceof ValidationError ? `Lamoda: ${error.message}` : 'Не удалось запустить проверку Lamoda.');}
        return;
      }
      case 'check': {
        await this.send('Выбери магазин:\n/check_randewoo — проверить Randewoo\n/check_ozon — проверить избранное Ozon\n/check_lamoda — проверить избранное Lamoda');
        return;
      }
      case 'status': {
        const status = this.tracker.status(), latest = status.checks[0];
        const lines = ['ℹ️ Price Checker', '', '🌸 Randewoo', status.queued ? 'Проверка ожидает в общей очереди.' : status.running ? 'Проверка выполняется.' : 'Ожидаю следующую проверку.',
          `Следующая проверка: ${date(status.next_check)}`, `Расписание: ${status.schedule_enabled ? 'включено' : 'выключено'}`];
        if (latest) lines.push(`Последняя проверка: №${latest.id}, ${labels[latest.status] || 'Выполняется'}, ${latest.completed}/${latest.total}`);
        if (['expired', 'error'].includes(status.auth_status)) lines.push('Подключение Randewoo требует внимания. Открой приложение для проверки сессии.');
        if (this.ozon) {
          const ozon = this.ozon.status(), latest = ozon.checks[0];
          lines.push('', '😎 Ozon', ozon.queued ? 'Проверка ожидает в общей очереди.' : ozon.running ? 'Проверка выполняется.' : 'Проверка не выполняется.',
            `Следующая проверка: ${date(ozon.next_check)}`, `Расписание: ${ozon.schedule_enabled ? 'включено' : 'выключено'}`);
          if (latest) lines.push(`Последняя проверка: №${latest.id}, ${labels[latest.status] || 'Выполняется'}, ${latest.completed}/${latest.total}`);
          if (ozon.action_required) lines.push('Подключение Ozon требует внимания.');
        } else lines.push('', 'Ozon: недоступен в приложении.');
        if (this.lamoda) {
          const lamoda = this.lamoda.status(),last = lamoda.checks[0];
          lines.push('','🛍️ Lamoda',lamoda.queued ? 'Проверка ожидает в общей очереди.' : lamoda.running ? 'Проверка выполняется.' : 'Ожидаю следующую проверку.',
            `Следующая проверка: ${date(lamoda.next_check)}`,`Расписание: ${lamoda.schedule_enabled ? 'включено' : 'выключено'}`);
          if (last) lines.push(`Последняя проверка: №${last.id}, ${labels[last.status] || last.status}, ${last.completed}/${last.total}`);
          if (lamoda.action_required || !lamoda.configured) lines.push('Нужно подтвердить вход в Lamoda.');
        }
        if (this.chat) lines.push(`Codex: сообщений в работе или ожидают доставки — ${this.chat.pending()}.`);
        await this.send(lines.join('\n')); return;
      }
      case 'new':
        await this.send(!this.chat ? 'Переписка с Codex пока не подключена.' : this.chat.newDialogue()
          ? 'Начат новый диалог с Codex. Напиши сообщение; предыдущая переписка сохранена отдельно.'
          : 'Дождись ответов на сообщения в очереди, затем отправь /new.');
        return;
      default:
        await this.send('Price Checker подключён.\n/check_randewoo — проверить Randewoo\n/check_ozon — проверить избранное Ozon\n/check_lamoda — проверить избранное Lamoda\n/lamoda_android — подключить телефон без ввода кода\n/check — выбрать магазин\n/status — состояние магазинов и расписаний\n/help — команды'
          + (this.chat ? '\n/new — новый диалог с Codex\n\nОбычные текстовые сообщения передаю Codex. Контекст диалога сохраняется.' : ''));
    }
  }

  async initializePolling() {
    const me = await this.api.call('getMe');
    if (!me?.is_bot || typeof me.username !== 'string') throw new TelegramError('invalid_response');
    this.username = me.username;
    const webhook = await this.api.call('getWebhookInfo');
    if (webhook?.url) throw new TelegramError('webhook_configured');
    await this.api.call('setMyCommands', {commands: [{command: 'check_randewoo', description: 'Проверить цены Randewoo'},
      {command: 'check_ozon', description: 'Проверить избранное Ozon'}, {command:'check_lamoda',description:'Проверить избранное Lamoda'}, {command: 'check', description: 'Выбрать магазин для проверки'},
      {command: 'lamoda_android', description: 'Подключить телефон для Lamoda'},
      {command: 'status', description: 'Состояние магазинов и расписаний'}, {command: 'help', description: 'Показать команды'},
      ...(this.chat ? [{command: 'new', description: 'Новый диалог с Codex'}] : [])]});
    this.log('telegram_ready');
  }

  async pollLoop() {
    let initialized = false, attempts = 0;
    while (!this.abort.signal.aborted) {
      try {
        if (!initialized) {await this.initializePolling(); initialized = true;}
        const updates = await this.api.call('getUpdates', {offset: this.db.setting(this.offsetKey, 0), limit: 25, timeout: 25, allowed_updates: ['message']});
        if (!Array.isArray(updates)) throw new TelegramError('invalid_response');
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          try {await this.handleUpdate(update);} catch (error) {this.log('telegram_command_failed', error);}
        }
        attempts = 0;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.log('telegram_poll_failed', error);
        await this.sleep(retryDelay(error, attempts++), undefined, {signal: this.abort.signal});
      }
    }
  }

  async notificationLoop() {
    while (!this.abort.signal.aborted) {
      try {await this.flush();} catch (error) {if (!this.abort.signal.aborted) this.log('telegram_notifications_failed', error);}
      await this.sleep(2000, undefined, {signal: this.abort.signal});
    }
  }

  async conversationLoop() {
    while (!this.abort.signal.aborted) {
      try {await this.chat.processNext();} catch (error) {if (!this.abort.signal.aborted) this.chat.log('telegram_ai_worker_failed', error);}
      await this.sleep(500, undefined, {signal: this.abort.signal});
    }
  }

  start({polling = true} = {}) {
    if (this.tasks) return;
    this.tasks = [this.notificationLoop(), ...(polling ? [this.pollLoop(), ...(this.chat ? [this.conversationLoop()] : [])] : [])].map(task => task.catch(() => {}));
  }
  async flush() {try {this.discoverChecks(); await this.deliverPending(); await this.chat?.deliverPending();} finally {await this.deliverLamoda();}}
  async close() {
    this.abort.abort(); this.api.close();
    await this.chat?.close();
    await Promise.allSettled([...(this.tasks || []), ...(this.deliveryPromise ? [this.deliveryPromise] : []),...(this.lamodaDelivery ? [this.lamodaDelivery] : [])]);
  }
}

export function createTelegramBot(tracker, env = process.env, logger = entry => console.info(JSON.stringify(entry)), {ozon,lamoda} = {}) {
  const file = env.PRICE_CHECKER_TELEGRAM_TOKEN_FILE, owner = env.PRICE_CHECKER_TELEGRAM_OWNER_ID;
  if (!file && !owner) return null;
  try {
    if (!file || !/^\d+$/.test(owner || '')) throw new TelegramError('configuration');
    let codexRunner;
    if (env.PRICE_CHECKER_CODEX_EXECUTABLE || env.PRICE_CHECKER_CODEX_WORKSPACE) {
      try {codexRunner = new CodexRunner({executable: env.PRICE_CHECKER_CODEX_EXECUTABLE, workspace: env.PRICE_CHECKER_CODEX_WORKSPACE});}
      catch {logger({time: now(), event: 'telegram_ai_disabled', reason: 'configuration'});}
    }
    return new TelegramBot(tracker, {ownerId: Number(owner), logger, codexRunner, ozon,lamoda, publicOrigin: env.PRICE_CHECKER_PUBLIC_ORIGIN,
      api: new TelegramApi({token: readFileSync(file, 'utf8').trim(), proxy: env.PRICE_CHECKER_TELEGRAM_PROXY})});
  } catch {
    logger({time: now(), event: 'telegram_disabled', reason: 'configuration'});
    return null;
  }
}
