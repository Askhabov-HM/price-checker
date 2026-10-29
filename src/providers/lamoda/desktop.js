import {migrateDesktop} from '../../storage-schema.js';
import {createHash,randomBytes} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {LamodaError,parseWishlistState,readAllFavorites} from './parser.js';
import {DesktopHistory} from './desktop-history.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const invalidPairing = () => new ValidationError('Ссылка подключения ПК недействительна. Создайте новую в Price Checker.');

export class LamodaDesktop {
  constructor(db,{current = Date.now,queue = null} = {}) {
    this.db = db;
    this.sql = db.db;
    this.current = current;
    this.queue = queue;
    migrateDesktop(this.sql);
    this.history = new DesktopHistory(db,current);
    if (this.schedule().enabled && !this.schedule().next_check) this.nextCheck();
  }
  pairing() {
    const code = randomBytes(16).toString('hex');
    const expires = this.current()+10*60000;
    this.sql.prepare('INSERT OR REPLACE INTO desktop_pairing VALUES(1,?,?)').run(digest(code),expires);
    return {code,expires_at:new Date(expires).toISOString()};
  }
  pair(code,name) {
    if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) throw invalidPairing();
    const row = this.sql.prepare('SELECT * FROM desktop_pairing WHERE id=1').get();
    if (!row || row.expires <= this.current() || row.code_hash !== digest(code)) throw invalidPairing();
    const token = randomBytes(32).toString('base64url');
    this.db.transaction(() => {
      this.sql.prepare('DELETE FROM desktop_pairing').run();
      this.sql.prepare('INSERT OR REPLACE INTO desktop_device VALUES(1,?,?,?)')
        .run(digest(token),typeof name === 'string' ? name.slice(0,80) : 'Windows',new Date(this.current()).toISOString());
    });
    return {token};
  }
  authenticate(value) {
    if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) return false;
    const valid = this.sql.prepare('SELECT id FROM desktop_device WHERE id=1 AND token_hash=?').get(digest(value.slice(7)));
    if (valid) this.sql.prepare('UPDATE desktop_device SET last_seen=? WHERE id=1').run(new Date(this.current()).toISOString());
    return !!valid;
  }
  async revoke() {
    await this.close();
    this.setSchedule(false);
    this.sql.prepare('DELETE FROM desktop_device').run();
    this.sql.prepare('DELETE FROM desktop_pairing').run();
  }
  status() {
    const device = this.sql.prepare('SELECT name,last_seen FROM desktop_device WHERE id=1').get();
    const latest = this.sql.prepare('SELECT run_id,received_at,item_count FROM desktop_snapshots ORDER BY received_at DESC LIMIT 1').get();
    const lastFailure = this.sql.prepare('SELECT id FROM desktop_failures ORDER BY id DESC LIMIT 1').get();
    return {enabled:!!device,device:device || null,latest:latest || null,not_before:this.notBefore(),schedule:this.schedule(),
      last_failure_id:lastFailure?.id || 0,job:this.job && this.job.status !== 'ended' ? this.jobState(this.job) : null};
  }
  schedule() {
    const state = this.sql.prepare('SELECT schedule_enabled,next_check,action_required,last_error FROM desktop_state WHERE id=1').get();
    return {enabled:!!state.schedule_enabled,interval_minutes:3,next_check:state.next_check,
      action_required:!!state.action_required,last_error:state.last_error};
  }
  setSchedule(enabled) {
    if (typeof enabled !== 'boolean') throw new ValidationError('Некорректное расписание ПК.');
    if (enabled && (!this.db.configured() || !this.status().enabled)) throw new ValidationError('Сначала подключите ПК и аккаунт Lamoda.');
    this.sql.prepare('UPDATE desktop_state SET schedule_enabled=?,next_check=?,action_required=0 WHERE id=1')
      .run(Number(enabled),enabled && (!this.job || this.job.status === 'ended') ? new Date(this.current()+3*60000).toISOString() : null);
    return this.schedule();
  }
  nextCheck(slot = null) {
    const now = this.current(),step = 3*60000;
    const nextAt = Number.isFinite(slot) ? slot+step*Math.max(1,Math.floor((now-slot)/step)+1) : now+step;
    const settings = this.schedule();
    const next = settings.enabled && !settings.action_required ? new Date(nextAt).toISOString() : null;
    this.sql.prepare('UPDATE desktop_state SET next_check=? WHERE id=1').run(next);
  }
  dashboard() {return this.history.dashboard();}
  detail(id,days) {return this.history.detail(id,days);}
  notBefore() {return this.sql.prepare('SELECT not_before FROM desktop_state WHERE id=1').get().not_before;}
  jobState(job) {return {id:job.id,status:job.status,expires_at:job.expires ? new Date(job.expires).toISOString() : null};}
  start({scheduled = false} = {}) {
    if (!this.queue || !this.db.configured()) throw new ValidationError('Пробный сбор Lamoda на ПК не настроен.');
    let slot = null;
    if (scheduled) {
      const schedule = this.schedule();
      if (!schedule.enabled || schedule.action_required || !schedule.next_check || Date.parse(schedule.next_check) > this.current())
        throw new ValidationError('Плановый сбор ПК пока не назначен.');
      slot = Date.parse(schedule.next_check);
    }
    if (Math.max(Date.parse(this.notBefore()) || 0,Date.parse(this.db.state().not_before) || 0) > this.current())
      throw new ValidationError('Сохраняется пауза источника Lamoda.');
    if (this.job && this.job.status !== 'ended') return this.jobState(this.job);
    const queueState = this.queue.status('lamoda');
    if (queueState.queued || queueState.active_store === 'lamoda') throw new ValidationError('Lamoda уже выполняет проверку.');
    if (this.queue.paused?.()) throw new ValidationError('Сбор временно приостановлен для обновления приложения.');
    const job = {id:randomBytes(16).toString('hex'),status:'queued',expires:null,runId:null,slot,
      controller:new AbortController(),resolve:null,timer:null,failed:false};
    this.job = job;
    this.sql.prepare('UPDATE desktop_state SET next_check=NULL WHERE id=1').run();
    const ticket = this.queue.enqueue('lamoda',() => {
      job.status = 'active';job.expires = this.current()+10*60000;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => this.finish(job),Math.max(0,job.expires-this.current()));job.timer.unref();
      return new Promise(resolve => {job.resolve = resolve;});
    },{signal:job.controller.signal});
    job.ticket = ticket;
    job.timer = setTimeout(() => this.finish(job),10*60000);job.timer.unref();
    ticket.done.catch(() => {}).finally(() => {if (job.status !== 'ended') this.finish(job);});
    return this.jobState(job);
  }
  currentJob(id) {
    const job = this.job;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || job?.id !== id) throw new LamodaError('interrupted');
    if (job.status === 'active' && this.current() >= job.expires) this.finish(job);
    return job;
  }
  getJob(id) {return this.jobState(this.currentJob(id));}
  finish(job) {
    if (job.status === 'ended') return;
    clearTimeout(job.timer);job.status = 'ended';
    if (!job.runId && !job.failed) this.failure('interrupted');
    this.nextCheck(job.slot);
    if (job.resolve) job.resolve();else job.controller.abort();
  }
  failure(code) {
    const safe = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'invalid_data';
    this.sql.prepare('INSERT INTO desktop_failures(at,code) VALUES(?,?)').run(new Date(this.current()).toISOString(),safe);
  }
  fail(id,{code,retry_after_ms:retryAfter} = {}) {
    const job = this.currentJob(id);
    if (job.status === 'ended') return {ok:true};
    const safeCode = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'invalid_data';
    if (job.status === 'active' && ['access_limited','rate_limited'].includes(code)
      && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      const value = new Date(this.current()+Math.min(retryAfter,365*86400000)).toISOString();
      if (Date.parse(value) > (Date.parse(this.notBefore()) || 0))
        this.sql.prepare('UPDATE desktop_state SET not_before=? WHERE id=1').run(value);
    }
    if (['login_required','account_mismatch'].includes(safeCode))
      this.sql.prepare('UPDATE desktop_state SET action_required=1,next_check=NULL,last_error=? WHERE id=1').run(safeCode);
    else this.sql.prepare('UPDATE desktop_state SET last_error=? WHERE id=1').run(safeCode);
    job.failed = true;this.failure(safeCode);
    this.finish(job);return {ok:true};
  }
  async close() {if (this.job) {this.finish(this.job);await this.job.ticket?.done.catch(() => {});}}
  async recordJob(id,runId,pages) {
    const job = this.currentJob(id);
    if (job.status !== 'active' && !(job.status === 'ended' && job.runId === runId)) throw new LamodaError('interrupted');
    if (job.status === 'active' && this.sql.prepare('SELECT 1 FROM desktop_snapshots WHERE run_id=?').get(runId))
      throw new LamodaError('incomplete_data');
    return this.record(runId,pages,() => {
      if (job.status === 'active' && this.current() >= job.expires) this.finish(job);
      if (job.status !== 'active' && !(job.status === 'ended' && job.runId === runId)) throw new LamodaError('interrupted');
    },() => {if (job.status === 'active') {job.runId = runId;this.finish(job);}});
  }
  async record(runId,pages,beforeWrite = () => {},afterWrite = () => {}) {
    if (typeof runId !== 'string' || !/^[a-f0-9]{32}$/.test(runId) || !Array.isArray(pages)
      || pages.length < 1 || pages.length > 1000) throw new LamodaError('invalid_data');
    let consumed = 0;
    const result = await readAllFavorites(async page => {
      const entry = pages[page-1];
      if (!entry || typeof entry !== 'object') throw new LamodaError('incomplete_data');
      consumed++;
      return parseWishlistState(entry.user,entry.payload);
    });
    if (consumed !== pages.length || !this.db.matches(result.account_id))
      throw new LamodaError(consumed !== pages.length ? 'incomplete_data' : 'account_mismatch');
    const account = this.db.accountDigest();
    const items = JSON.stringify(result.items);
    const payloadHash = digest(account+'\n'+items);
    const saved = this.db.transaction(() => {
      beforeWrite();
      const existing = this.sql.prepare('SELECT payload_hash,item_count,received_at FROM desktop_snapshots WHERE run_id=?').get(runId);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new LamodaError('incomplete_data');
        return {run_id:runId,count:existing.item_count,received_at:existing.received_at,duplicate:true};
      }
      const received = new Date(this.current()).toISOString();
      this.sql.prepare('INSERT INTO desktop_snapshots VALUES(?,?,?,?,?,?)')
        .run(runId,received,account,result.items.length,payloadHash,items);
      this.history.index(runId,received,result.items);
      this.sql.prepare('UPDATE desktop_state SET not_before=NULL,action_required=0,last_error=NULL WHERE id=1').run();
      return {run_id:runId,count:result.items.length,received_at:received,duplicate:false};
    });
    if (!saved.duplicate) afterWrite();
    return saved;
  }
}
