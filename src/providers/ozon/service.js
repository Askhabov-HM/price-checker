import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireInstance, AlreadyRunning} from '../../instance.js';
import {ValidationError} from '../../errors.js';
import {OzonDatabase, itemSku} from './database.js';
import {OzonClient, OzonReadError} from './client.js';
import {OZON_INTERVAL_MS} from './probe.js';
import {OzonLogin} from './login.js';

export class OzonService {
  constructor(root, {client = new OzonClient(root),current = Date.now,pause = delay,notify} = {}) {
    this.root = root; this.db = new OzonDatabase(root); this.client = client; this.current = current; this.pause = pause;
    this.running = null; this.closing = false;
    this.login = new OzonLogin(root,{notify,onAuthorized:() => {
      this.db.updateState({action_required:0,message:'',next_check:this.db.state().schedule_enabled ? this.stamp() : null});
    }});
  }
  stamp() {return new Date(this.current()).toISOString();}
  status() {
    const state = this.db.state(), checks = this.db.checks();
    return {available:true,configured:this.client.configured(),running:!!this.running || checks[0]?.status === 'running',
      schedule_enabled:!!state.schedule_enabled,interval_minutes:120,next_check:state.schedule_enabled ? state.next_check : null,
      not_before:state.not_before,action_required:!!state.action_required,message:state.message,login:this.login.status(),checks};
  }
  settings(data) {
    if (typeof data.schedule_enabled !== 'boolean') throw new ValidationError('Укажите состояние расписания Ozon.');
    if (data.schedule_enabled && (!this.client.configured() || this.db.state().action_required)) throw new ValidationError('Сначала восстановите подключение Ozon.');
    const state = this.db.state();
    this.db.updateState({schedule_enabled:Number(data.schedule_enabled),next_check:data.schedule_enabled ? new Date(Math.max(this.current()+OZON_INTERVAL_MS,Date.parse(state.not_before) || 0)).toISOString() : null});
  }
  watch(url) {if (this.closing) throw new ValidationError('Приложение останавливается.'); return this.db.watch(url,true,this.stamp());}
  unwatch(id) {const product = this.db.product(itemSku(id)); if (!product) throw new ValidationError('Товар Ozon не найден.'); this.db.watch(product.url,false,this.stamp());}
  allowed() {
    if (this.closing || this.running) throw new ValidationError('Проверка Ozon уже выполняется или приложение останавливается.');
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
    this.running = this.execute({id,trigger,signal:this.controller.signal}).finally(async () => {
      await release();this.running = null;
      if (this.loginNeeded && !this.closing) {this.loginNeeded = false;await this.login.require();}
    });
    this.running.catch(() => {});
    // The HTTP response returns before collection; errors are represented by persisted checks.
    return {started:true};
  }
  async execute({id,trigger,signal}) {
    this.db.recover(this.stamp());
    if (this.db.state().action_required) return;
    const check = this.db.begin(trigger,this.stamp());
    this.db.updateState({action_required:1,message:'Проверка Ozon прервана. Проверьте подключение перед повтором.'});
    let target,failed = 0,imported = null;
    try {
      const context = await this.client.open(signal);
      this.db.bindContext(context,{legacyDigest:this.client.legacyContextDigest});
      if (!id) {
        const lists = await this.client.lists();
        if (signal.aborted) throw new OzonReadError('interrupted');
        imported = lists.favorites;
        this.db.recordFavorites(check,imported,this.stamp(),this.client.source || 'http');
      } else this.db.snapshotLists(check);
      // The full refresh is complete after reading favorites; only an explicit
      // single-product request may open a product card.
      const targets = id ? [this.db.product(itemSku(id))] : [];
      if (targets.length > 100) throw new OzonReadError('invalid_data');
      if (id) this.db.progress(check,targets.length);
      for (const [index, product] of targets.entries()) {
        target = product.sku;
        if (signal.aborted) throw new OzonReadError('interrupted');
        if (index) await this.pause(2500,undefined,{signal});
        try {
          const result = await this.client.product(product.sku,product.url);
          this.db.observe(check,result,this.stamp(),this.client.source || 'http');
        } catch (error) {
          if (!(error instanceof OzonReadError) || error.retry_after_ms > 0
            || !['redirect','invalid_data','network_error','http_error','unexpected_content','response_too_large'].includes(error.code)) throw error;
          this.db.failure(check,product.sku,error.message,this.stamp(),this.client.source || 'http');failed++;
        }
        target = null;
      }
      const next = new Date(this.current()+OZON_INTERVAL_MS).toISOString();
      const message = imported !== null
        ? `Избранное обновлено. Товаров: ${imported.length}. Цены получены: ${imported.filter(item => item.listed_price_kopecks !== null).length}.`
        : failed ? `Проверено товаров: ${targets.length}. Не удалось получить цены: ${failed}. Прежние цены сохранены.` : `Проверено товаров: ${targets.length}.`;
      this.db.updateState({not_before:null,next_check:next,action_required:0,message:failed ? message : ''});
      this.db.finish(check,failed ? 'partial' : 'success',message,this.stamp());
    } catch (error) {
      const known = error instanceof OzonReadError;
      if (known && error.code === 'login_required') this.loginNeeded = true;
      const message = known ? error.message : signal.aborted ? 'Проверка Ozon остановлена.' : 'Не удалось проверить Ozon. Предыдущие данные сохранены.';
      if (target) this.db.failure(check,target,message,this.stamp(),this.client.source || 'http');
      const wait = Math.max(known ? error.retry_after_ms : 0,known && error.code === 'rate_limited' ? 6*3600000 : 0);
      const next = wait ? new Date(Math.min(this.current()+wait,8.64e15)).toISOString() : null;
      this.db.updateState({not_before:next,next_check:next,action_required:1,message});
      this.db.finish(check,signal.aborted ? 'interrupted' : 'error',message,this.stamp());
    } finally {await this.client.close?.();}
  }
  async startScheduler() {
    let release;
    try {release = await acquireInstance(join(this.root,'.data/ozon/collector.lock')); this.db.recover(this.stamp());} catch { /* A CLI check may own the lock. */ }
    finally {await release?.();}
    if (this.closing) return;
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
  async close() {this.closing = true; clearInterval(this.timer); this.controller?.abort(); await this.running; await this.login.close();this.db.close();}
}
export function createOzonService(root, options) {
  try {return new OzonService(root,options);} catch {return null;}
}
