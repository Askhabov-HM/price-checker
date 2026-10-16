import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {parseResponse, quote} from './randewoo-transport.js';
import {now} from './time.js';
import {CodexChat, CodexRunner} from './codex-chat.js';

const methods = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'setMyCommands']);
const labels = {success: 'Успешно', partial: 'Есть ошибки', error: 'Ошибка', interrupted: 'Прервана'};
const triggers = {schedule: 'По расписанию', manual: 'Из приложения', telegram: 'Из Telegram', cli: 'Из командной строки'};
const date = value => value ? new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short'}).format(new Date(value)) + ' МСК' : '—';
const money = value => (value / 100).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' ₽';
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

export function checkMessage(db, check) {
  const lines = [`Price Checker · проверка №${check.id}`, `${labels[check.status] || check.status} · ${triggers[check.trigger] || 'Проверка'}`,
    `Проверено товаров: ${check.completed}/${check.total}`, `Завершена: ${date(check.finished_at)}`];
  const changes = db.all(`SELECT current.price,current.context,p.brand,p.name,
    (SELECT old.price FROM observations old WHERE old.variant_id=current.variant_id AND old.context=current.context
      AND old.id<current.id AND (old.check_id IS NULL OR old.check_id!=current.check_id)
      AND old.status='ok' AND old.price IS NOT NULL ORDER BY old.id DESC LIMIT 1) AS previous_price
    FROM observations current JOIN variants v ON v.id=current.variant_id JOIN products p ON p.id=v.product_id
    WHERE current.check_id=? AND current.status='ok' AND current.price IS NOT NULL
      AND current.id=(SELECT MAX(last.id) FROM observations last WHERE last.check_id=current.check_id
        AND last.variant_id=current.variant_id AND last.context=current.context)`, check.id)
    .filter(row => row.previous_price != null && row.previous_price !== row.price);
  lines.push(`Изменений цен: ${changes.length}`);
  for (const row of changes.slice(0, 8)) lines.push(`${short((row.brand + ' ' + row.name).replace(/\s+/g, ' '), 90)} · ${row.context === 'cart' ? 'корзина' : 'сайт'}: ${money(row.previous_price)} → ${money(row.price)}`);
  if (changes.length > 8) lines.push(`Ещё изменений: ${changes.length - 8}`);
  if (check.status !== 'success') lines.push(short(check.message, 1500));
  return short(lines.join('\n'), 4000);
}

export class TelegramBot {
  constructor(tracker, {api, ownerId, codexRunner, logger = entry => console.info(JSON.stringify(entry)), sleep = delay} = {}) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new TelegramError('configuration');
    this.tracker = tracker; this.db = tracker.db; this.api = api; this.ownerId = ownerId;
    this.logger = logger; this.sleep = sleep; this.abort = new AbortController();
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
    if (codexRunner) this.chat = new CodexChat(this.db, {runner: codexRunner, ownerId, send: text => this.send(text), logger});
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
        if (check.status !== 'imported') this.db.run('INSERT OR IGNORE INTO telegram_outbox(check_id,owner_id,text) VALUES(?,?,?)',
          check.id, this.ownerId, checkMessage(this.db, check));
        this.db.setSetting(this.cursorKey, check.id);
      });
    }
  }

  deliverPending() {
    if (!this.deliveryPromise) this.deliveryPromise = (async () => {
      while (!this.abort.signal.aborted) {
        const row = this.db.get('SELECT * FROM telegram_outbox WHERE owner_id=? AND delivered_at IS NULL AND next_attempt_ms<=? ORDER BY check_id LIMIT 1', this.ownerId, Date.now());
        if (!row) break;
        try {
          await this.send(row.text);
          this.db.run('UPDATE telegram_outbox SET delivered_at=? WHERE check_id=? AND owner_id=?', now(), row.check_id, this.ownerId);
          this.log('telegram_check_delivered');
        } catch (error) {
          if (!this.abort.signal.aborted) {
            this.db.run('UPDATE telegram_outbox SET attempts=attempts+1,next_attempt_ms=? WHERE check_id=? AND owner_id=?',
              Date.now() + retryDelay(error, row.attempts), row.check_id, this.ownerId);
            this.log('telegram_delivery_failed', error);
          }
          break;
        }
      }
    })().finally(() => {this.deliveryPromise = null;});
    return this.deliveryPromise;
  }

  send(text) {return this.api.call('sendMessage', {chat_id: this.ownerId, text: short(text, 4000), link_preview_options: {is_disabled: true}});}

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
    // Persist before dispatch: an interrupted /check must not start a second collection after restart.
    this.db.setSetting(this.offsetKey, update.update_id + 1);
    if (!allowed) return;
    const command = /^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(message.text);
    if (command?.[2] && command[2].toLowerCase() !== this.username?.toLowerCase()) return;
    switch (command?.[1].toLowerCase()) {
      case 'check': {
        const started = this.tracker.startRefresh('telegram');
        await this.send(started ? 'Проверка цен запущена. Пришлю результат после завершения.' : 'Проверка уже выполняется или приложение останавливается. Новую проверку не запускал.');
        return;
      }
      case 'status': {
        const status = this.tracker.status(), latest = status.checks[0];
        const lines = ['Price Checker', status.running ? 'Проверка выполняется.' : 'Ожидаю следующую проверку.',
          `Следующая проверка: ${date(status.next_check)}`, `Расписание: ${status.schedule_enabled ? 'включено' : 'выключено'}`];
        if (latest) lines.push(`Последняя проверка: №${latest.id}, ${labels[latest.status] || 'Выполняется'}, ${latest.completed}/${latest.total}`);
        if (['expired', 'error'].includes(status.auth_status)) lines.push('Подключение Randewoo требует внимания. Открой приложение для проверки сессии.');
        if (this.chat) lines.push(`Codex: сообщений в работе или ожидают доставки — ${this.chat.pending()}.`);
        await this.send(lines.join('\n')); return;
      }
      case 'new':
        await this.send(!this.chat ? 'Переписка с Codex пока не подключена.' : this.chat.newDialogue()
          ? 'Начат новый диалог с Codex. Напиши сообщение; предыдущая переписка сохранена отдельно.'
          : 'Дождись ответов на сообщения в очереди, затем отправь /new.');
        return;
      default:
        await this.send('Price Checker подключён.\n/check — проверить цены\n/status — состояние и следующая проверка\n/help — команды'
          + (this.chat ? '\n/new — новый диалог с Codex\n\nОбычные текстовые сообщения передаю Codex. Контекст диалога сохраняется.' : ''));
    }
  }

  async initializePolling() {
    const me = await this.api.call('getMe');
    if (!me?.is_bot || typeof me.username !== 'string') throw new TelegramError('invalid_response');
    this.username = me.username;
    const webhook = await this.api.call('getWebhookInfo');
    if (webhook?.url) throw new TelegramError('webhook_configured');
    await this.api.call('setMyCommands', {commands: [{command: 'check', description: 'Проверить цены'},
      {command: 'status', description: 'Состояние и следующая проверка'}, {command: 'help', description: 'Показать команды'},
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
  async flush() {this.discoverChecks(); await this.deliverPending(); await this.chat?.deliverPending();}
  async close() {
    this.abort.abort(); this.api.close();
    await this.chat?.close();
    await Promise.allSettled([...(this.tasks || []), ...(this.deliveryPromise ? [this.deliveryPromise] : [])]);
  }
}

export function createTelegramBot(tracker, env = process.env, logger = entry => console.info(JSON.stringify(entry))) {
  const file = env.PRICE_CHECKER_TELEGRAM_TOKEN_FILE, owner = env.PRICE_CHECKER_TELEGRAM_OWNER_ID;
  if (!file && !owner) return null;
  try {
    if (!file || !/^\d+$/.test(owner || '')) throw new TelegramError('configuration');
    let codexRunner;
    if (env.PRICE_CHECKER_CODEX_EXECUTABLE || env.PRICE_CHECKER_CODEX_WORKSPACE) {
      try {codexRunner = new CodexRunner({executable: env.PRICE_CHECKER_CODEX_EXECUTABLE, workspace: env.PRICE_CHECKER_CODEX_WORKSPACE});}
      catch {logger({time: now(), event: 'telegram_ai_disabled', reason: 'configuration'});}
    }
    return new TelegramBot(tracker, {ownerId: Number(owner), logger, codexRunner,
      api: new TelegramApi({token: readFileSync(file, 'utf8').trim(), proxy: env.PRICE_CHECKER_TELEGRAM_PROXY})});
  } catch {
    logger({time: now(), event: 'telegram_disabled', reason: 'configuration'});
    return null;
  }
}
