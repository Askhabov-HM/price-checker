import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireInstance} from '../../instance.js';
import {ValidationError} from '../../errors.js';
import {nextScheduledCheck,scheduleSettings} from '../../schedule.js';
import {LamodaDatabase} from './database.js';
import {LamodaChannel} from './channel.js';
import {LamodaLogin} from './login.js';
import {LamodaError} from './parser.js';
import {LamodaMobile} from './mobile.js';
import {LamodaDesktop} from './desktop.js';
import {FirebaseSender,LamodaPush} from './push.js';
import {collectionQueue} from '../../collection-queue.js';
import {retryCollectionRead} from '../../collection-retry.js';

export class LamodaService {
  constructor(root,{channel = options => new LamodaChannel(options),current = Date.now,pause = delay,logger = event => console.info(JSON.stringify(event)),pushSender = new FirebaseSender(root,{current})} = {}) {
    this.root = root;this.db = new LamodaDatabase(root);this.channel = channel;this.current = current;this.logger = logger;
    this.collectionQueue = collectionQueue(root);
    this.pause = pause;
    this.mobile = new LamodaMobile(this.db,{current});
    this.mobileRequests = new Map();
    this.desktop = new LamodaDesktop(this.db,{current,queue:this.collectionQueue});
    this.push = new LamodaPush(this.mobile,pushSender,{current});this.mobile.push = this.push;
    this.login = new LamodaLogin(root,{db:this.db,channel:() => channel({timeout:60000}),onAuthorized:() => {
      this.db.updateState({action_required:0,message:'',next_check:this.nextAttempt()});
    }});
  }
  stamp() {return new Date(this.current()).toISOString();}
  config() {const state = this.db.state();return {...state,schedule_enabled:!!state.schedule_enabled,schedule:JSON.parse(state.schedule)};}
  nextAttempt(notBefore = null) {
    const state = this.config();if (!state.schedule_enabled) return null;
    return nextScheduledCheck(state,new Date(Math.max(this.current(),(Date.parse(notBefore)||0)-1)));
  }
  status() {const state = this.config(),desktop = this.desktop.status();
    const pause = Math.max(Date.parse(state.not_before)||0,Date.parse(desktop.not_before)||0);
    const mobile = this.mobile.status();
    if (this.running && this.mobileOperation && this.collectionQueue.status('lamoda').queued)
      mobile.runtime = {state:'queued',job_id:null,last_contact:null,stage:'waiting'};
    return {...state,available:true,browser_available:!!this.channel().available?.(),configured:this.db.configured(),running:!!this.running,
    ...this.collectionQueue.status('lamoda'),
    queued:!!this.running && this.collectionQueue.status('lamoda').queued,
    next_check:state.schedule_enabled ? state.next_check : null,not_before:pause ? new Date(pause).toISOString() : null,
    action_required:!!state.action_required,checks:this.db.checks(),login:this.login.status(),mobile,desktop};}
  settings(data) {
    const old = this.config(),config = scheduleSettings(data,old);
    if (config.schedule_enabled && (!this.db.configured() || old.action_required)) throw new ValidationError('Сначала подключите аккаунт Lamoda.');
    const anchor = config.schedule_mode !== old.schedule_mode || config.interval_minutes !== old.interval_minutes || !old.schedule_anchor
      ? new Date(this.current()+config.interval_minutes*60000).toISOString() : old.schedule_anchor;
    const next = config.schedule_enabled ? nextScheduledCheck({...config,schedule_anchor:anchor},new Date(Math.max(this.current(),Date.parse(old.not_before)||0))) : null;
    this.db.transaction(() => this.db.updateState({...config,schedule:JSON.stringify(config.schedule),schedule_enabled:Number(config.schedule_enabled),schedule_anchor:anchor,next_check:next}));
  }
  allowed(checkRunning = true,{browserOnly = false} = {}) {
    if (this.closing || checkRunning && this.running) throw new ValidationError('Проверка Lamoda уже выполняется.');
    if (this.desktop.status().job) throw new ValidationError('Пробный сбор Lamoda на ПК уже выполняется.');
    const state = this.db.state();
    if ((!this.db.configured() || state.action_required) && (browserOnly || !this.mobile.enabled())) throw new ValidationError('Нужно подтвердить вход в Lamoda.');
    if (browserOnly && !this.channel().available?.()) throw new ValidationError('Браузер Lamoda на сервере недоступен.');
    if (Date.parse(state.not_before) > this.current()) throw new ValidationError('Сохраняется пауза источника Lamoda.');
    if (Date.parse(this.desktop.notBefore()) > this.current()) throw new ValidationError('Сохраняется пауза источника Lamoda.');
  }
  async start({trigger = 'manual',browserOnly = false,mobileRun = null} = {}) {
    if (typeof browserOnly !== 'boolean' || browserOnly && trigger !== 'manual') throw new ValidationError('Некорректный источник сбора Lamoda.');
    this.allowed(true,{browserOnly});
    let release;
    try {release = await acquireInstance(join(this.root,'.data/lamoda/collector.lock'));} catch {throw new ValidationError('Lamoda занята сбором или входом.');}
    if (mobileRun && this.mobile.runs.get(mobileRun)?.state === 'canceled') {await release();return {started:false,canceled:true};}
    if (this.closing || this.running) {await release();throw new ValidationError('Приложение останавливается или проверка уже выполняется.');}
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const operation = randomBytes(16).toString('hex');
    this.operationId = operation;this.mobileOperation = !browserOnly && this.mobile.enabled();
    if (mobileRun) this.mobile.runs.link(mobileRun,operation);
    let queued = false;
    const ticket = this.collectionQueue.enqueue('lamoda',() => {
      if (trigger === 'schedule' && !this.db.state().schedule_enabled) return;
      this.allowed(false,{browserOnly});
      return this.execute(browserOnly ? 'vps' : trigger,signal,{remind:trigger !== 'android' || queued,browserOnly,operation});
    },{signal});
    this.running = ticket.done.finally(async () => {
      this.mobile.runs.finish(operation,'ended');
      await release();this.running = null;this.activeCheck = null;this.operationId = null;this.mobileOperation = false;
    });
    this.running.catch(() => {});await ticket.ready;
    queued = this.collectionQueue.status('lamoda').queued;
    return {started:true,queued};
  }
  async execute(trigger,signal,{remind = trigger !== 'android',browserOnly = false,operation = null} = {}) {
    const check = this.db.begin(trigger,this.stamp());
    this.activeCheck = check;
    if (operation) this.mobile.runs.bind(operation,check);
    let preserveAndroidSchedule = false;
    try {
      preserveAndroidSchedule = browserOnly && this.mobile.enabled();
      const mobile = !browserOnly && this.mobile.enabled(),expires = this.current()+10*60000;
      const result = await retryCollectionRead(async () => {
        if (mobile && this.current() >= expires) throw new LamodaError('interrupted');
        const result = mobile ? await this.mobile.collect(check,signal,{remind,expires}) : await this.channel({signal}).request('collect',{account_digest:this.db.accountDigest()});
        if (signal.aborted) throw new LamodaError('interrupted');
        if (mobile && !this.db.configured()) this.db.bindAccount(result.account_id);
        if (!this.db.matches(result.account_id)) throw new LamodaError('account_mismatch');
        return result;
      },{signal,pause:(ms,value,options) => this.pause(mobile ? Math.min(ms,Math.max(0,expires-this.current())) : ms,value,options),
        retryable:error => error instanceof LamodaError && !['login_required','account_mismatch','interrupted'].includes(error.code),
        onRetry:retry => {
          this.db.db.prepare('UPDATE checks SET message=? WHERE id=?').run(`Повторная попытка ${retry.attempt} из ${retry.total}.`,check);
          this.logger({time:this.stamp(),store:'lamoda',event:'collection_retry',check_id:check,...retry});
        }});
      this.db.record(check,result.items,this.stamp(),mobile ? 'android' : 'browser');
      if (operation) this.mobile.runs.finish(operation,'completed');
      this.db.updateState(preserveAndroidSchedule ? {message:''} : {action_required:0,message:'',not_before:null,next_check:this.nextAttempt()});
      this.logger({time:this.stamp(),store:'lamoda',event:'collection_success',check_id:check,count:result.items.length});
    } catch (error) {
      const code = signal.aborted ? 'interrupted' : error instanceof LamodaError ? error.code : 'invalid_data';
      const message = new LamodaError(code).message;
      const required = ['login_required','account_mismatch'].includes(code);
      const wait = error instanceof LamodaError && Number.isFinite(error.retry_after_ms) ? Math.min(Math.max(0,error.retry_after_ms),365*86400000) : 0;
      const notBefore = wait ? new Date(this.current()+wait).toISOString() : null;
      this.db.failure(check,message,this.stamp(),code === 'interrupted' ? 'interrupted' : 'error');
      if (operation) this.mobile.runs.finish(operation,code === 'interrupted' ? 'ended' : 'failed');
      const next = preserveAndroidSchedule && !wait ? this.db.state().next_check : required ? null : this.nextAttempt(notBefore);
      this.db.updateState(preserveAndroidSchedule && !wait ? {message} : {action_required:Number(required),message,not_before:notBefore,next_check:next});
      this.logger({time:this.stamp(),store:'lamoda',event:'collection_error',check_id:check,reason:code,http_status:error?.http_status ?? null,next_check:next});
    }
  }
  async stopMobile(id) {
    const check = this.mobile.stop(id);
    if (check !== null && check === this.activeCheck) {
      this.controller?.abort();
      await this.running;
    }
    return {ok:true};
  }
  async mobileRequest(id,{manual = false,expected = null} = {}) {
    // A lost HTTP response must not create another manual check on retry.
    if (this.mobileRequests.has(id)) return this.mobileRequests.get(id);
    const work = this.requestMobileRun(id,{manual,expected});
    this.mobileRequests.set(id,work);
    try {return await work;} finally {this.mobileRequests.delete(id);}
  }
  async requestMobileRun(id,{manual,expected}) {
    let run = this.mobile.runs.request(id);
    if (!['requested','active'].includes(run.state)) return {job:null,outcome:run.state};
    if (!run.operation_id) {
      if (expected && this.mobile.next()?.id !== expected) {this.mobile.runs.end(id,'idle');return {job:null,outcome:'idle'};}
      if (manual && !this.running) {
        try {await this.start({trigger:'android',mobileRun:id});}
        catch (error) {if (!this.mobile.runs.get(id).operation_id) this.mobile.runs.end(id,'failed');throw error;}
      } else if (this.running && this.mobileOperation) this.mobile.runs.link(id,this.operationId,this.activeCheck ?? null);
      else {this.mobile.runs.end(id,'idle');return {job:null,outcome:'idle'};}
      run = this.mobile.runs.get(id);
    }
    if (!['requested','active'].includes(run.state)) return {job:null,outcome:run.state};
    if (run.operation_id !== this.operationId || !this.running) {this.mobile.runs.end(id,'ended');return {job:null,outcome:'ended'};}
    const job = this.mobile.next();
    if (job && this.sqlCheckForJob(job.id) === run.check_id) return {job,outcome:'active'};
    return {job:null,queued:true,outcome:'waiting'};
  }
  sqlCheckForJob(id) {return this.db.db.prepare('SELECT check_id FROM mobile_jobs WHERE id=?').get(id)?.check_id;}
  async stopMobileRun(id,jobId = null) {
    if (jobId !== null && (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId))) throw new ValidationError('Некорректное задание Android.');
    const run = this.mobile.runs.cancel(id);
    // Push already names a job even when Android has not fetched it yet.
    if (!run.operation_id && jobId) {
      const job = this.db.db.prepare('SELECT check_id FROM mobile_jobs WHERE id=?').get(jobId);
      const status = job && this.db.db.prepare('SELECT status FROM checks WHERE id=?').get(job.check_id)?.status;
      const saved = status === 'success';
      if (saved) {this.mobile.runs.end(id,'completed');return {ok:true,outcome:'completed'};}
      if (!job || status !== 'running') {this.mobile.runs.end(id,'ended');return {ok:true,outcome:'ended'};}
      this.db.db.prepare('UPDATE mobile_runs SET check_id=?,operation_id=? WHERE id=?').run(job.check_id,job.check_id===this.activeCheck ? this.operationId : null,id);
      if (job) await this.stopMobile(jobId);
    }
    if (run.outcome === 'canceled' && run.operation_id && run.operation_id === this.operationId && this.running) {
      this.mobile.runs.finish(run.operation_id,'canceled');
      this.controller?.abort();
      await this.running.catch(() => {});
    }
    return {ok:true,outcome:run.outcome};
  }
  async startScheduler() {
    let release;
    try {release = await acquireInstance(join(this.root,'.data/lamoda/collector.lock'));this.mobile.cancel();this.db.recover(this.stamp());}
    catch { /* Another process owns the collector. */ } finally {await release?.();}
    const state = this.db.state();
    if (state.schedule_enabled && !state.action_required && !state.next_check) this.db.updateState({next_check:this.nextAttempt(state.not_before)});
    this.timer = setInterval(() => {this.tick().catch(() => this.logger({time:this.stamp(),store:'lamoda',event:'scheduler_error'}));},30000);this.timer.unref();
    this.pushTimer = setInterval(() => {this.push.flush().catch(() => this.logger({time:this.stamp(),store:'lamoda',event:'push_error'}));},2000);this.pushTimer.unref();
  }
  async tick() {
    const state = this.db.state();
    if (!this.closing && !this.running && !this.desktop.status().job && !(Date.parse(this.desktop.notBefore()) > this.current())
      && state.schedule_enabled && !state.action_required && state.next_check && Date.parse(state.next_check) <= this.current()) await this.start({trigger:'schedule'});
  }
  async close() {this.closing = true;clearInterval(this.timer);clearInterval(this.pushTimer);this.controller?.abort();await this.desktop.close();await this.running?.catch(() => {});await this.push.running;await this.login.close();this.db.close();}
}
export function createLamodaService(root,options) {
  try {return new LamodaService(root,options);} catch {console.error(JSON.stringify({store:'lamoda',event:'storage_unavailable'}));return null;}
}
