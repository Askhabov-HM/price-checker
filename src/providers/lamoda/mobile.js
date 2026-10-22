import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ValidationError} from '../../errors.js';
import {LamodaError,parseWishlistState,readAllFavorites} from './parser.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new ValidationError('Ссылка подключения недействительна. Получите новую в личном боте: /lamoda_android.');
const jobError = () => new ValidationError('Проверка истекла или отменена. Нажмите «Собрать сейчас».');
export class LamodaMobile {
  constructor(db,{current = Date.now} = {}) {
    this.db = db;this.sql = db.db;this.current = current;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mobile_device(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL,name TEXT NOT NULL,last_seen TEXT);
      CREATE TABLE IF NOT EXISTS mobile_pairing(id INTEGER PRIMARY KEY CHECK(id=1),code_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mobile_jobs(id TEXT PRIMARY KEY,check_id INTEGER NOT NULL REFERENCES checks(id),status TEXT NOT NULL,expires INTEGER NOT NULL,
        next_page INTEGER NOT NULL DEFAULT 1,result TEXT,error TEXT,bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mobile_pages(job_id TEXT NOT NULL REFERENCES mobile_jobs(id) ON DELETE CASCADE,page INTEGER NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,page));`);
  }
  enabled() {return !!this.sql.prepare('SELECT id FROM mobile_device WHERE id=1').get();}
  status() {
    const device = this.sql.prepare('SELECT name,last_seen FROM mobile_device WHERE id=1').get();
    const job = this.sql.prepare("SELECT id,expires,next_page FROM mobile_jobs WHERE status='pending' AND expires>? ORDER BY rowid DESC LIMIT 1").get(this.current());
    return {enabled:!!device,device:device || null,job:job || null,push:this.push?.status() ?? null};
  }
  pairing() {
    const code = randomBytes(16).toString('hex'),expires = this.current()+10*60000;
    this.sql.prepare('INSERT OR REPLACE INTO mobile_pairing VALUES(1,?,?)').run(hash(code),expires);
    return {code,expires_at:new Date(expires).toISOString()};
  }
  pair(code,name) {
    if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) throw unavailable();
    const row = this.sql.prepare('SELECT * FROM mobile_pairing WHERE id=1').get();
    if (!row || row.expires <= this.current() || row.code_hash !== hash(code)) throw unavailable();
    const token = randomBytes(32).toString('base64url');
    this.db.transaction(() => {
      this.cancel();this.push?.reset();this.sql.prepare('DELETE FROM mobile_pairing').run();
      this.sql.prepare('INSERT OR REPLACE INTO mobile_device VALUES(1,?,?,?)').run(hash(token),typeof name === 'string' ? name.slice(0,80) : 'Android',new Date(this.current()).toISOString());
    });
    return {token};
  }
  authenticate(value) {
    if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) return false;
    const valid = this.sql.prepare('SELECT id FROM mobile_device WHERE id=1 AND token_hash=?').get(hash(value.slice(7)));
    if (valid) this.sql.prepare('UPDATE mobile_device SET last_seen=? WHERE id=1').run(new Date(this.current()).toISOString());
    return !!valid;
  }
  revoke() {this.cancel();this.push?.reset();this.sql.prepare('DELETE FROM mobile_device').run();this.sql.prepare('DELETE FROM mobile_pairing').run();}
  cancel() {
    this.sql.prepare("UPDATE mobile_jobs SET status='canceled',result=NULL WHERE status='pending'").run();
    this.sql.prepare("DELETE FROM mobile_pages WHERE job_id IN (SELECT id FROM mobile_jobs WHERE status!='pending')").run();
    this.sql.prepare("UPDATE telegram_outbox SET delivered_at=? WHERE delivered_at IS NULL AND event_id LIKE 'android:%'").run(new Date(this.current()).toISOString());
  }
  next() {return this.status().job;}
  stop(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw jobError();
    // A delayed stop may refer to an old job. Never cancel a newer scheduled check.
    const row = this.sql.prepare('SELECT check_id,status,result FROM mobile_jobs WHERE id=?').get(id);
    if (!row || !(row.status === 'pending' || row.status === 'complete' && row.result !== null)) return null;
    this.sql.prepare("UPDATE mobile_jobs SET status='canceled',result=NULL WHERE id=?").run(id);
    this.sql.prepare('DELETE FROM mobile_pages WHERE job_id=?').run(id);
    return row.check_id;
  }
  job(id) {
    const row = typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? this.sql.prepare('SELECT * FROM mobile_jobs WHERE id=?').get(id) : null;
    if (!row || row.expires <= this.current() || !['pending','complete'].includes(row.status)) throw jobError();
    return row;
  }
  async accept(id,page,user,payload) {
    const job = this.job(id),parsed = parseWishlistState(user,payload),data = JSON.stringify(parsed),digest = hash(data);
    if (!Number.isSafeInteger(page) || parsed.pagination.page !== page) throw new LamodaError('incomplete_data');
    if (this.db.configured() && !this.db.matches(parsed.account_id)) throw new LamodaError('account_mismatch');
    const existing = this.sql.prepare('SELECT digest FROM mobile_pages WHERE job_id=? AND page=?').get(id,page);
    if (existing) {
      if (existing.digest !== digest) throw new LamodaError('incomplete_data');
      return {complete:job.status === 'complete',next_page:job.next_page};
    }
    if (job.status !== 'pending' || page !== job.next_page || job.bytes+Buffer.byteLength(data)>32*1024*1024) throw new LamodaError('incomplete_data');
    const first = this.sql.prepare('SELECT data FROM mobile_pages WHERE job_id=? AND page=1').get(id);
    if (first) {
      const previous = JSON.parse(first.data);
      if (previous.account_id !== parsed.account_id || JSON.stringify([...previous.favorites].sort()) !== JSON.stringify([...parsed.favorites].sort())
        || ['found','limit','pages'].some(key => previous.pagination[key] !== parsed.pagination[key])) throw new LamodaError('incomplete_data');
    }
    this.db.transaction(() => {
      this.sql.prepare('INSERT INTO mobile_pages VALUES(?,?,?,?)').run(id,page,digest,data);
      this.sql.prepare('UPDATE mobile_jobs SET next_page=?,bytes=bytes+? WHERE id=?').run(page+1,Buffer.byteLength(data),id);
    });
    if (page >= parsed.pagination.pages) {
      const result = await readAllFavorites(async number => {
        const stored = this.sql.prepare('SELECT data FROM mobile_pages WHERE job_id=? AND page=?').get(id,number);
        if (!stored) throw jobError();
        return JSON.parse(stored.data);
      });
      if (this.job(id).status !== 'pending') throw jobError();
      this.sql.prepare("UPDATE mobile_jobs SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),id);
      return {complete:true,count:result.items.length,next_page:page+1};
    }
    return {complete:false,next_page:page+1};
  }
  fail(id,code,retryAfter = 0,httpStatus = null) {
    this.job(id);
    if (!['login_required','account_mismatch','account_unverified','incomplete_data','invalid_data','access_limited','rate_limited','interrupted'].includes(code)) code = 'invalid_data';
    const error = {code,retry_after_ms:Number.isSafeInteger(retryAfter) ? Math.max(0,Math.min(retryAfter,365*86400000)) : 0,http_status:[403,429].includes(httpStatus) ? httpStatus : null};
    this.sql.prepare("UPDATE mobile_jobs SET status='error',error=? WHERE id=? AND status='pending'").run(JSON.stringify(error),id);
  }
  async collect(check,signal,{remind = true} = {}) {
    this.cancel();
    this.sql.prepare("DELETE FROM mobile_jobs WHERE status!='pending'").run();
    const id = randomBytes(16).toString('hex'),expires = this.current()+10*60000;
    this.sql.prepare("INSERT INTO mobile_jobs(id,check_id,status,expires) VALUES(?,?,'pending',?)").run(id,check,expires);
    this.sql.prepare('INSERT INTO telegram_outbox(event_id,check_id,payload) VALUES(?,?,?)')
      .run('android:'+id,check,JSON.stringify({store:'lamoda',kind:'android',finishedAt:new Date(this.current()).toISOString()}));
    if (remind) this.push?.enqueue(id);
    try {
      while (!signal.aborted && this.current()<expires) {
        const row = this.sql.prepare('SELECT status,result,error FROM mobile_jobs WHERE id=?').get(id);
        if (row?.status === 'complete') return JSON.parse(row.result);
        if (row?.status === 'error') {const error = JSON.parse(row.error);throw new LamodaError(error.code,error.retry_after_ms,error.http_status);}
        if (row?.status !== 'pending') throw new LamodaError('interrupted');
        await delay(250,undefined,{signal});
      }
      throw new LamodaError('interrupted');
    } finally {
      this.sql.prepare("UPDATE mobile_jobs SET status='canceled' WHERE id=? AND status='pending'").run(id);
      this.sql.prepare('UPDATE mobile_jobs SET result=NULL WHERE id=?').run(id);
      this.sql.prepare('UPDATE telegram_outbox SET delivered_at=? WHERE event_id=? AND delivered_at IS NULL')
        .run(new Date(this.current()).toISOString(),'android:'+id);
      // Keep normalized pages briefly for idempotent upload acknowledgements.
    }
  }
}
