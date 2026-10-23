import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireInstance, AlreadyRunning} from '../../instance.js';
import {ValidationError} from '../../errors.js';
import {OzonDatabase, itemSku} from './database.js';
import {OzonClient, OzonReadError} from './client.js';
import {OzonLogin} from './login.js';
import {nextScheduledCheck, scheduleSettings} from '../../schedule.js';
import {inspectBrowserCollection} from './recovery.js';
import {collectionQueue} from '../../collection-queue.js';
import {retryCollectionRead} from '../../collection-retry.js';

const legacyRetryMessages = new Set([
  'Ozon ограничил доступ. Проверки приостановлены.',
  'Ozon попросил снизить частоту. Проверки приостановлены.',
  'Не удалось подтвердить серверный браузер Ozon. Проверки приостановлены.',
  'Предыдущая проверка Ozon прервана.',
  'Проверка Ozon прервана. Проверьте подключение перед повтором.',
  'Не удалось проверить Ozon. Предыдущие данные сохранены.',
  'Ozon не вернул подтверждённые данные. Проверки приостановлены.',
  ...['access_limited','rate_limited','incomplete_data','invalid_data','network_error','browser_unverified','interrupted','http_error'].map(code => new OzonReadError(code).message),
]);

export class OzonService {
  constructor(root, {client = new OzonClient(root),current = Date.now,pause = delay,notify,monitor = inspectBrowserCollection,logger = event => console.info(JSON.stringify(event))} = {}) {
    this.root = root; this.db = new OzonDatabase(root); this.client = client; this.current = current; this.pause = pause;
    this.collectionQueue = collectionQueue(root);
    this.logger = logger;
    this.running = null; this.closing = false;
    this.browserStatus=monitor;
    const state = this.db.state();
    if (!state.schedule_anchor) this.db.updateState({schedule_anchor:state.next_check || new Date(this.current()+state.interval_minutes*60000).toISOString()});
    this.login = new OzonLogin(root,{notify,onAuthorized:() => {
      this.db.updateState({action_required:0,message:'',next_check:this.db.state().schedule_enabled ? nextScheduledCheck(this.scheduleConfig(),new Date(this.current())) : null});
    }});
  }
  stamp() {return new Date(this.current()).toISOString();}
  nextAttempt(notBefore = null) {
    if (!this.db.state().schedule_enabled) return null;
    // A slot exactly at the end of Retry-After is already allowed.
    const earliest = Math.max(this.current(),(Date.parse(notBefore) || 0)-1);
    return nextScheduledCheck(this.scheduleConfig(),new Date(earliest));
  }
  resumeScheduledError() {
    const state = this.db.state();
    if (!state.action_required || !legacyRetryMessages.has(state.message) || this.db.checks()[0]?.status === 'running') return;
    this.db.updateState({action_required:0,next_check:this.nextAttempt(state.not_before),message:state.schedule_enabled
      ? 'Последний сбор завершился ошибкой. Следующая попытка — по расписанию.'
      : 'Последний сбор завершился ошибкой. Можно повторить сбор.'});
  }
  scheduleConfig() {
    const state = this.db.state();
    return {schedule_mode:state.schedule_mode,schedule:JSON.parse(state.schedule),interval_minutes:state.interval_minutes,
      schedule_anchor:state.schedule_anchor,schedule_enabled:!!state.schedule_enabled};
  }
  status() {
    const state = this.db.state(), checks = this.db.checks();
    return {available:true,configured:this.client.configured(),running:!!this.running || checks[0]?.status === 'running',
      ...this.collectionQueue.status('ozon'),
      ...this.scheduleConfig(),next_check:state.schedule_enabled ? state.next_check : null,
      not_before:state.not_before,action_required:!!state.action_required,message:state.message,login:this.login.status(),checks};
  }
  settings(data) {
    const config = scheduleSettings(data,this.scheduleConfig());
    if (config.schedule_enabled && (!this.client.configured() || this.db.state().action_required)) throw new ValidationError('Сначала восстановите подключение Ozon.');
    const state = this.db.state();
    const current = new Date(this.current()), schedule_anchor = new Date(current.getTime()+config.interval_minutes*60000).toISOString();
    const earliest = state.not_before && Date.parse(state.not_before)>current.getTime() ? new Date(state.not_before) : current;
    const next = config.schedule_enabled ? nextScheduledCheck({...config,schedule_anchor},earliest) : null;
    this.db.transaction(() => this.db.updateState({...config,schedule:JSON.stringify(config.schedule),schedule_anchor,
      schedule_enabled:Number(config.schedule_enabled),next_check:next}));
  }
  watch(url) {if (this.closing) throw new ValidationError('Приложение останавливается.'); return this.db.watch(url,true,this.stamp());}
  unwatch(id) {const product = this.db.product(itemSku(id)); if (!product) throw new ValidationError('Товар Ozon не найден.'); this.db.watch(product.url,false,this.stamp());}
  allowed(checkRunning = true) {
    if (this.closing || checkRunning && this.running) throw new ValidationError('Проверка Ozon уже выполняется или приложение останавливается.');
    if (!this.client.configured()) throw new ValidationError('Подключение Ozon ещё не настроено.');
    const state = this.db.state();
    if (state.action_required) throw new ValidationError(state.message || 'Нужно восстановить подключение Ozon.');
    if (state.not_before && Date.parse(state.not_before) > this.current()) throw new ValidationError('Сохраняется пауза Ozon до следующей проверки.');
  }
  async start({id = null,trigger = 'manual'} = {}) {
    this.allowed();
    if (id !== null && !this.db.product(itemSku(id))) throw new ValidationError('Товар Ozon не найден.');
    let release;
    try {release = await acquireInstance(join(this.root,'.data/ozon/collector.lock'));}
    catch (error) {throw new ValidationError(error instanceof AlreadyRunning ? 'Проверка Ozon уже выполняется.' : 'Не удалось начать проверку Ozon.');}
    try {this.allowed();} catch (error) {await release(); throw error;}
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const ticket = this.collectionQueue.enqueue('ozon',() => {
      if (trigger === 'schedule' && !this.db.state().schedule_enabled) return;
      this.allowed(false);
      return this.execute({id,trigger,signal});
    },{signal});
    this.running = ticket.done.finally(async () => {
      await release();this.running = null;
      if (this.loginNeeded && !this.closing) {this.loginNeeded = false;await this.login.require();}
    });
    this.running.catch(() => {});
    await ticket.ready;
    // The HTTP response returns before collection; errors are represented by persisted checks.
    return {started:true,queued:this.collectionQueue.status('ozon').queued};
  }
  async execute({id,trigger,signal}) {
    this.db.recover(this.stamp());
    if (this.db.state().action_required) return;
    const check = this.db.begin(trigger,this.stamp());
    this.db.updateState({action_required:1,message:'Проверка Ozon прервана. Проверьте подключение перед повтором.'});
    let target,failed = 0,imported = null;
    try {
      target = id ? itemSku(id) : null;
      let fetched;
      try {
        fetched = await retryCollectionRead(async () => {
          try {
            const context = await this.client.open(signal);
            this.db.bindContext(context,{legacyDigest:this.client.legacyContextDigest});
            return id ? await this.client.product(target,this.db.product(target).url) : await this.client.lists();
          } finally {await this.client.close?.();}
        },{signal,pause:this.pause,
          retryable:error => error instanceof OzonReadError && !['login_required','context_mismatch','interrupted'].includes(error.code),
          onRetry:retry => {
            this.db.db.prepare('UPDATE checks SET message=? WHERE id=?').run(`Повторная попытка ${retry.attempt} из ${retry.total}.`,check);
            this.logger({time:this.stamp(),store:'ozon',event:'collection_retry',check_id:check,...retry});
          }});
      } catch (error) {
        if (!id || !(error instanceof OzonReadError) || error.retry_after_ms > 0
          || !['redirect','invalid_data','network_error','http_error','unexpected_content','response_too_large'].includes(error.code)) throw error;
        this.db.failure(check,target,error.message,this.stamp(),this.client.source || 'browser');failed++;
      }
      if (signal.aborted) throw new OzonReadError('interrupted');
      if (!id) {
        // Re-read availability for every favorite, including unavailable items,
        // so returned products immediately resume recording fresh prices.
        imported = fetched.favorites;
        this.db.recordFavorites(check,imported,this.stamp(),this.client.source || 'browser');
      } else this.db.snapshotLists(check);
      // The full refresh is complete after reading favorites; only an explicit
      // single-product request may open a product card.
      const targets = id ? [this.db.product(itemSku(id))] : [];
      if (id) this.db.progress(check,targets.length);
      if (id && !failed) this.db.observe(check,fetched,this.stamp(),this.client.source || 'browser');
      target = null;
      const next = this.db.state().schedule_enabled ? nextScheduledCheck(this.scheduleConfig(),new Date(this.current())) : null;
      const message = imported !== null
        ? `Избранное обновлено. Товаров: ${imported.length}. Цены получены: ${imported.filter(item => item.listed_price_kopecks !== null).length}.`
        : failed ? `Проверено товаров: ${targets.length}. Не удалось получить цены: ${failed}. Прежние цены сохранены.` : `Проверено товаров: ${targets.length}.`;
      this.db.updateState({not_before:null,next_check:next,action_required:0,message:failed ? message : ''});
      this.db.finish(check,failed ? 'partial' : 'success',message,this.stamp());
    } catch (error) {
      const known = error instanceof OzonReadError;
      if (known && error.code === 'login_required') this.loginNeeded = true;
      const message = known ? error.message : error instanceof ValidationError ? 'Нужно проверить конфигурацию подключения Ozon.'
        : signal.aborted ? 'Проверка Ozon остановлена.' : 'Не удалось проверить Ozon. Предыдущие данные сохранены.';
      if (target) this.db.failure(check,target,message,this.stamp(),this.client.source || 'browser');
      const actionRequired = error instanceof ValidationError || known && ['login_required','context_mismatch'].includes(error.code);
      const wait = Math.max(known ? error.retry_after_ms : 0,0);
      const notBefore = wait ? new Date(Math.min(this.current()+wait,8.64e15-86400000)).toISOString() : null;
      const next = actionRequired ? null : this.nextAttempt(notBefore);
      this.db.updateState({not_before:notBefore,next_check:next,action_required:Number(actionRequired),message});
      this.db.finish(check,signal.aborted ? 'interrupted' : 'error',message,this.stamp());
    }
  }
  async startScheduler() {
    let release;
    try {release = await acquireInstance(join(this.root,'.data/ozon/collector.lock')); this.db.recover(this.stamp());} catch { /* A CLI check may own the lock. */ }
    finally {await release?.();}
    if (this.closing) return;
    this.resumeScheduledError();
    if (this.db.state().action_required && this.db.state().message === 'Нужно обновить вход в Ozon.') await this.login.require();
    this.timer = setInterval(() => {this.tick().catch(() => {});},30000);
    this.timer.unref();
  }
  async tick() {
    const state = this.db.state();
    if (!this.closing && this.login.required) await this.login.require();
    if (this.closing || !state.schedule_enabled || this.running || state.action_required || !state.next_check || Date.parse(state.next_check) > this.current()) return;
    await this.start({trigger:'schedule'});
  }
  async close() {this.closing = true; clearInterval(this.timer); this.controller?.abort(); await this.running?.catch(() => {}); await this.login.close();this.db.close();}
}
export function createOzonService(root, options) {
  try {return new OzonService(root,options);} catch {return null;}
}
