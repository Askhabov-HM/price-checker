import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createPrivateKey,sign} from 'node:crypto';
import {ValidationError} from '../../errors.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/firebase.messaging';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export class PushError extends Error {
  constructor(code,{retry = 60000,invalidToken = false} = {}) {super(code);this.code = code;this.retry = retry;this.invalidToken = invalidToken;}
}
export class FirebaseSender {
  constructor(root,{credentials,fetcher = fetch,current = Date.now} = {}) {
    this.fetcher = fetcher;this.current = current;
    try {
      const value = credentials ?? JSON.parse(readFileSync(join(root,'.secrets/lamoda/firebase-service-account.json'),'utf8'));
      if (value.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,62}$/.test(value.project_id)
        || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(value.client_email)) throw new Error();
      this.key = createPrivateKey(value.private_key);this.project = value.project_id;this.email = value.client_email;
      if (this.key.asymmetricKeyType !== 'rsa') throw new Error();
    } catch {this.key = null;}
  }
  configured() {return !!this.key;}
  async request(url,options) {
    try {
      const response = await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      // Never propagate provider responses, which can contain registration tokens or credentials.
      const reader = response.body.getReader();let text = '';
      try {while (true) {const {done,value} = await reader.read();if (done) break;text+=Buffer.from(value).toString('utf8');if (text.length>65536) throw new Error();}}
      finally {await reader.cancel().catch(() => {});}
      let data;try {data = JSON.parse(text);} catch {throw new PushError('invalid_response');}
      return {response,data};
    } catch (error) {throw error instanceof PushError ? error : new PushError('network_error');}
  }
  async accessToken() {
    if (!this.key) throw new PushError('not_configured');
    if (this.access && this.access.expires>this.current()+60000) return this.access.value;
    const now = Math.floor(this.current()/1000),input = encoded({alg:'RS256',typ:'JWT'})+'.'+encoded({iss:this.email,scope,aud:TOKEN_URL,iat:now,exp:now+3600});
    const assertion = input+'.'+sign('RSA-SHA256',Buffer.from(input),this.key).toString('base64url');
    const {response,data} = await this.request(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    if (!response.ok || typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new PushError('authorization_failed',{retry:15*60000});
    this.access = {value:data.access_token,expires:this.current()+Math.min(data.expires_in,3600)*1000};return this.access.value;
  }
  async send(token,job,{validateOnly = false} = {}) {
    const access = await this.accessToken();
    const ttl = Math.floor((job.expires-this.current())/1000);if (ttl<=0) return;
    const {response,data} = await this.request('https://fcm.googleapis.com/v1/projects/'+this.project+'/messages:send',{
      method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({validate_only:validateOnly,message:{token,
        notification:{title:'Пора обновить Lamoda',body:'Нажмите, чтобы открыть избранное и начать сбор.'},
        data:{lamoda_job:job.id,lamoda_expires:String(job.expires)},
        android:{priority:'HIGH',ttl:ttl+'s',collapse_key:'lamoda-reminder',restricted_package_name:'ru.pricechecker.lamoda',
          notification:{channel_id:'lamoda_reminders',icon:'ic_notification',tag:'lamoda-reminder',color:'#16745C',default_sound:true,proxy:'DENY'}}}})});
    if (response.ok && typeof data.name === 'string') return;
    if (response.status === 401) this.access = null;
    const fcmCode = data.error?.details?.find(item => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
    if (fcmCode === 'UNREGISTERED') throw new PushError('token_expired',{invalidToken:true});
    // INVALID_ARGUMENT can mean a bad payload; do not delete a valid device token on that response.
    const after = response.headers.get('retry-after'),seconds = /^\d+$/.test(after || '') ? Number(after)*1000 : Date.parse(after)-this.current();
    const retry = Math.max(response.status === 429 ? 60000 : 30000,Number.isFinite(seconds) ? seconds : 0);
    throw new PushError(response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'send_failed',{retry});
  }
}

export class LamodaPush {
  constructor(mobile,sender,{current = Date.now} = {}) {
    this.mobile = mobile;this.sql = mobile.sql;this.sender = sender;this.current = current;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mobile_push_device(id INTEGER PRIMARY KEY CHECK(id=1),device_hash TEXT NOT NULL,
      token TEXT,enabled INTEGER NOT NULL DEFAULT 0,registered_at TEXT,accepted_at TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS mobile_push_outbox(job_id TEXT PRIMARY KEY REFERENCES mobile_jobs(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,accepted_at TEXT);`);
  }
  status() {
    const row = this.sql.prepare('SELECT enabled,registered_at,accepted_at,error FROM mobile_push_device WHERE id=1').get();
    return {configured:this.sender.configured(),enabled:!!row?.enabled,registered_at:row?.registered_at ?? null,accepted_at:row?.accepted_at ?? null,error:row?.error ?? null};
  }
  register(input) {
    if (typeof input.enabled !== 'boolean' || typeof input.token !== 'string' || !/^[A-Za-z0-9_:\-]{20,4096}$/.test(input.token)
      || input.project_id !== this.sender.project) throw new ValidationError('Некорректные настройки уведомлений. Обновите приложение.');
    const device = this.sql.prepare('SELECT token_hash FROM mobile_device WHERE id=1').get();
    if (!device) throw new ValidationError('Подключите телефон заново.');
    this.sql.prepare(`INSERT INTO mobile_push_device(id,device_hash,token,enabled,registered_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET device_hash=excluded.device_hash,token=excluded.token,enabled=excluded.enabled,registered_at=excluded.registered_at,error=NULL`)
      .run(device.token_hash,input.token,Number(input.enabled),new Date(this.current()).toISOString());
    return this.status();
  }
  reset() {this.sql.exec('DELETE FROM mobile_push_outbox; DELETE FROM mobile_push_device;');}
  enqueue(job) {
    const device = this.sql.prepare('SELECT token_hash FROM mobile_device WHERE id=1').get();
    if (device) this.sql.prepare('INSERT OR IGNORE INTO mobile_push_outbox(job_id,device_hash) VALUES(?,?)').run(job,device.token_hash);
  }
  async flush() {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => {this.running = null;});return this.running;
  }
  async deliver() {
    if (!this.sender.configured()) return;
    const row = this.sql.prepare(`SELECT o.*,j.expires,d.token FROM mobile_push_outbox o JOIN mobile_jobs j ON j.id=o.job_id
      JOIN mobile_push_device d ON d.device_hash=o.device_hash JOIN mobile_device m ON m.token_hash=d.device_hash
      WHERE o.accepted_at IS NULL AND o.next_attempt<=? AND j.status='pending' AND j.expires>? AND d.enabled=1 AND d.token IS NOT NULL LIMIT 1`).get(this.current(),this.current());
    if (!row) return;
    try {
      await this.sender.send(row.token,{id:row.job_id,expires:row.expires});
      const stamp = new Date(this.current()).toISOString();
      this.sql.prepare('UPDATE mobile_push_outbox SET accepted_at=? WHERE job_id=? AND device_hash=?').run(stamp,row.job_id,row.device_hash);
      this.sql.prepare('UPDATE mobile_push_device SET accepted_at=?,error=NULL WHERE device_hash=? AND token=?').run(stamp,row.device_hash,row.token);
    } catch (error) {
      const known = error instanceof PushError ? error : new PushError('send_failed');
      this.sql.prepare('UPDATE mobile_push_outbox SET attempts=attempts+1,next_attempt=? WHERE job_id=?')
        .run(this.current()+Math.max(known.retry,Math.min(15*60000,30000*2**Math.min(row.attempts,5))),row.job_id);
      this.sql.prepare('UPDATE mobile_push_device SET error=?,token=CASE WHEN ? THEN NULL ELSE token END,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE device_hash=? AND token=?')
        .run(known.code,Number(known.invalidToken),Number(known.invalidToken),row.device_hash,row.token);
    }
  }
}
