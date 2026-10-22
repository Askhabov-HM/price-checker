import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Database} from './database.js';
import {Randewoo, productUrl, quote} from './client.js';
import {AuthError, FetchError, ValidationError} from './errors.js';
import {now} from './time.js';
import {nextScheduledCheck, scheduledSlot, scheduleSettings} from './schedule.js';
import {RandewooLogin} from './randewoo-login.js';
import {collectionQueue} from './collection-queue.js';

export class Tracker {
  constructor(root, {databasePath, client} = {}) {
    this.root = root;
    this.collectionQueue = collectionQueue(root);
    this.db = new Database(databasePath || join(root, '.data/prices.sqlite3'));
    if (!this.db.setting('schedule_anchor')) this.db.setSetting('schedule_anchor',new Date(Date.now()+30*60000).toISOString());
    this.db.setSetting('last_started_slot', null);
    this.client = client || new Randewoo(join(root, '.secrets/randewoo-session.json'));
    this.randewooLogin = new RandewooLogin(this.client.transport, data => {
      this.saveSession(data);
      this.db.setSetting('auth_status', 'ok');
      this.db.setSetting('auth_message', 'Randewoo подключён. Запустите проверку для обновления списков');
    });
    this.running = false;
    this.closing = false;
    this.refreshPromise = null;
    this.timer = null;
    this.importHistory();
  }

  importHistory() {
    if (this.db.setting('history_imported', false)) return;
    const directory = join(this.root, '.data/imports'), snapshots = [];
    if (existsSync(directory)) for (const filename of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
        const stamp = now(new Date(data.checked_at_utc));
        if (data.list === 'cart' && data.authorized === true && Array.isArray(data.items)) {
          const items = data.items.filter(item => item.matches_target_volume).map(item => {
            if (!Number.isSafeInteger(item.price_kopecks) || item.price_kopecks <= 0) throw new Error();
            return {...item, url: productUrl(item.url)};
          });
          snapshots.push({stamp, items, filename});
        }
      } catch { /* Not a valid, real probe snapshot. */ }
    }
    for (const snapshot of snapshots.sort((a, b) => a.stamp.localeCompare(b.stamp))) {
      const {stamp, items, filename} = snapshot;
      const checkId = this.db.startCheck('import', stamp);
      const entries = [];
      for (const item of items) {
        const id = this.db.variant(item);
        this.db.observation(id, item, 'cart', checkId, stamp, 'Сохранённый реальный снимок: ' + filename);
        entries.push([id, item.quantity || 1]);
      }
      this.db.syncList('cart', entries, stamp);
      this.db.updateCheck(checkId, {status: 'imported', total: entries.length, completed: entries.length, finished_at: stamp, message: 'Импорт ранее полученного реального снимка'});
    }
    try {
      const item = JSON.parse(readFileSync(join(directory, 'icon-first-observation.json'), 'utf8'));
      if (item.sku === '446826' && item.price_context === 'public_without_login' && item.volume_ml === '1.5' && Number.isSafeInteger(item.price_kopecks) && item.price_kopecks > 0) {
        const stamp = now(new Date(item.checked_at_utc));
        Object.assign(item, {url: productUrl(item.url), brand: 'Alfred Dunhill', name: 'Icon', variant: 'парфюмерная вода 1,5мл', in_stock: String(item.availability || '').endsWith('/InStock')});
        const id = this.db.variant(item), checkId = this.db.startCheck('import', stamp);
        this.db.observation(id, item, 'public', checkId, stamp, 'Первый реальный тест карточки');
        this.db.syncList('watching', [[id, 1]], stamp);
        this.db.updateCheck(checkId, {status: 'imported', total: 1, completed: 1, finished_at: stamp, message: 'Импорт первого теста Alfred Dunhill Icon'});
      }
    } catch { /* First test is optional. */ }
    this.db.setSetting('history_imported', true);
  }

  scheduleConfig() {
    return {schedule:this.db.setting('schedule'),schedule_mode:this.db.setting('schedule_mode','hours'),
      interval_minutes:this.db.setting('interval_minutes',30),schedule_enabled:this.db.setting('schedule_enabled',true),
      schedule_anchor:this.db.setting('schedule_anchor')};
  }
  status() {
    const config = this.scheduleConfig();
    return {running: this.running, ...this.collectionQueue.status('randewoo'), checks: this.db.checks(), ...config, timezone: 'Europe/Moscow',
      next_check: config.schedule_enabled ? nextScheduledCheck(config) : null, session_present: existsSync(this.client.sessionPath || join(this.root, '.secrets/randewoo-session.json')),
      auth_status: this.db.setting('auth_status', 'unknown'), auth_message: this.db.setting('auth_message', ''), csrf_token: null,
      runtime: 'node.js', version: '1.0.0'};
  }

  startRefresh(trigger = 'manual') {
    if (this.running || this.closing) return false;
    this.refreshNow(trigger).catch(() => {});
    return true;
  }

  refreshNow(trigger = 'manual') {
    if (this.running || this.closing) throw new ValidationError('Проверка уже выполняется');
    this.running = true;
    this.controller = new AbortController();
    const ticket = this.collectionQueue.enqueue('randewoo',() => {
      if (trigger === 'schedule' && !this.db.setting('schedule_enabled',true)) return;
      return this.refresh(trigger);
    },{signal:this.controller.signal});
    this.refreshReady = ticket.ready;
    this.refreshPromise = ticket.done.finally(() => {this.running = false;});
    return this.refreshPromise;
  }

  async refresh(trigger) {
    const checkId = this.db.startCheck(trigger), errors = [];
    this.client.checkId = checkId;
    const favoriteUrls = new Set(), cartFallbackUrls = new Set();
    let cartError = null, cartPricedIds = null;
    try {
      let authorized = false;
      try {
        await this.client.authorizedUser();
        this.db.setSetting('auth_status', 'ok');
        this.db.setSetting('auth_message', 'Сессия Randewoo действует');
        authorized = true;
      } catch (error) {
        if (!(error instanceof FetchError)) throw error;
        errors.push(error.message);
        cartError = error.message;
        this.db.setSetting('auth_status', error instanceof AuthError ? 'expired' : 'error');
        this.db.setSetting('auth_message', error.message);
      }
      if (authorized && !this.closing) {
        try {
          const cart = await this.client.cart(), stamp = now();
          const resolved = cart.map(item => {
            const meta = {...item};
            if (!item.matches_target_volume) {
              Object.assign(meta, {sku: null, variant: '1,5 мл'});
              cartFallbackUrls.add(item.url);
            }
            return {id: this.db.variant(meta), item};
          });
          this.db.syncList('cart', resolved.map(({id, item}) => [id, item.quantity]), stamp);
          cartPricedIds = new Set(resolved.filter(({item}) => item.matches_target_volume).map(({id}) => id));
          for (const {id, item} of resolved) if (item.matches_target_volume) this.db.observation(id, item, 'cart', checkId, stamp);
        } catch (error) {
          if (!(error instanceof FetchError)) throw error;
          errors.push('Корзина: ' + error.message);
          cartError = error.message;
        }
        try {
          const favorites = await this.client.favorites(), entries = [];
          for (const item of favorites) {
            favoriteUrls.add(item.url);
            this.db.variant(item);
            entries.push(...this.db.productVariants(item.url).map(variant => [variant.id, 1]));
          }
          this.db.syncList('favorites', entries);
        } catch (error) {
          if (!(error instanceof FetchError)) throw error;
          errors.push('Избранное: ' + error.message);
        }
      }
      const products = [...new Map(this.db.activeVariants().map(variant => [variant.url, variant])).values()];
      this.db.updateCheck(checkId, {total: products.length, message: 'Получение цен вариантов 1,5 мл'});
      let next = 0, completed = 0;
      const worker = async () => {
        while (!this.closing && next < products.length) {
          const variant = products[next++];
          await delay(150);
          if (this.closing) return;
          let items;
          try {items = await this.client.products(variant.url);}
          catch (error) {items = [{status: 'error', message: error instanceof FetchError ? error.message : 'Не удалось обработать карточку товара'}];}
          if (this.closing) return;
          const known = this.db.productVariants(variant.url);
          if (items[0].status === 'error') {
            errors.push(`${variant.brand} ${variant.name}: ${items[0].message}`);
            for (const old of known) this.db.observation(old.id, items[0], 'public', checkId);
          } else {
            const resolved = items.map(item => ({id: this.db.variant(item), item}));
            const observed = new Set(resolved.map(row => row.id));
            if (favoriteUrls.has(variant.url)) this.db.addMembers('favorites', observed);
            if (cartFallbackUrls.has(variant.url)) this.db.addMembers('cart', observed);
            for (const {id, item} of resolved) this.db.observation(id, item, 'public', checkId);
            for (const old of known) if (!observed.has(old.id)) this.db.observation(old.id, {status: 'missing', in_stock: false, message: 'Вариант временно отсутствует на странице'}, 'public', checkId);
          }
          this.db.updateCheck(checkId, {completed: ++completed});
        }
      };
      await Promise.all([worker(), worker()]);
      if (this.closing) {
        this.db.updateCheck(checkId, {status: 'interrupted', finished_at: now(), message: 'Приложение остановлено во время проверки'});
        return {check_id: checkId, errors: 1};
      }
      const cartStamp = now();
      for (const row of this.db.rows('cart', 'cart')) {
        if (cartError) this.db.observation(row.id, {status: 'error', message: cartError}, 'cart', checkId, cartStamp);
        else if (cartPricedIds && !cartPricedIds.has(row.id)) this.db.observation(row.id,
          {status: 'missing', in_stock: false, message: 'Вариант 1,5 мл отсутствует в корзине аккаунта'}, 'cart', checkId, cartStamp);
      }
      let message = 'Проверено товаров: ' + products.length;
      if (errors.length) message += '. ' + errors.slice(0, 5).join('; ') + (errors.length > 5 ? '. Ещё ошибок: ' + (errors.length - 5) : '');
      this.db.updateCheck(checkId, {status: errors.length ? 'partial' : 'success', message, finished_at: now()});
      this.db.setSetting('last_completed_slot', scheduledSlot(this.scheduleConfig()));
      await this.db.backup(join(this.root, '.data/backups'));
      return {check_id: checkId, count: products.length, errors: errors.length};
    } catch {
      this.db.updateCheck(checkId, {status: this.closing ? 'interrupted' : 'error', message: 'Проверка прервана. Предыдущие данные сохранены', finished_at: now()});
      return {check_id: checkId, errors: 1};
    } finally {this.client.checkId = null;}
  }

  async addUrl(url, listId = 'watching') {
    if (!['watching', 'my-cart'].includes(listId)) throw new ValidationError('Этот список обновляется с Randewoo');
    const items = await this.client.products(productUrl(url));
    if (this.closing) throw new ValidationError('Приложение останавливается');
    let id = null;
    for (const item of items) {id = this.db.variant(item); this.db.localMember(listId, id); this.db.observation(id, item, 'public');}
    return id;
  }

  saveSettings(data) {
    const config = scheduleSettings(data,this.scheduleConfig()), current = new Date();
    const anchor = new Date(current.getTime()+config.interval_minutes*60000).toISOString();
    this.db.transaction(() => {
      for (const [key,value] of Object.entries({...config,schedule_anchor:anchor})) this.db.setSetting(key,value);
      this.db.setSetting('last_completed_slot', scheduledSlot({...config,schedule_anchor:anchor},current));
      this.db.setSetting('last_started_slot', null);
    });
  }

  saveSession(data) {
    if (typeof data.cookie !== 'string' || typeof data.user_agent !== 'string') throw new ValidationError('Нужны Cookie и User-Agent из запроса Randewoo');
    const cookie = data.cookie.trim(), userAgent = data.user_agent.trim();
    if (!cookie || cookie.length > 50000 || !userAgent || userAgent.length > 1000) throw new ValidationError('Нужны Cookie и User-Agent из запроса Randewoo');
    quote(cookie); quote(userAgent);
    const path = this.client.sessionPath;
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path + '.tmp', JSON.stringify({cookie, user_agent: userAgent}), {encoding: 'utf8', mode: 0o600});
    renameSync(path + '.tmp', path);
    this.randewooLogin.clear();
    this.db.setSetting('auth_status', 'unknown');
    this.db.setSetting('auth_message', 'Сессия сохранена. Запустите проверку');
  }

  schedulerTick(current = new Date()) {
    if (!this.db.setting('schedule_enabled', true)) return false;
    const slot = scheduledSlot(this.scheduleConfig(), current);
    if (slot && this.db.setting('last_completed_slot') !== slot && this.db.setting('last_started_slot') !== slot && this.startRefresh('schedule')) {
      this.db.setSetting('last_started_slot', slot);
      return true;
    }
    return false;
  }
  startScheduler() {
    const tick = () => {try {this.schedulerTick();} catch { /* A failed interval can be retried manually. */ }};
    tick();
    this.timer = setInterval(tick, 15000);
  }
  async close() {
    if (!this.closePromise) this.closePromise = (async () => {
      clearInterval(this.timer);
      this.closing = true;
      this.controller?.abort();
      this.randewooLogin.clear();
      this.client.close?.();
      await this.refreshPromise?.catch(() => {});
      this.db.close();
    })();
    return this.closePromise;
  }
}
