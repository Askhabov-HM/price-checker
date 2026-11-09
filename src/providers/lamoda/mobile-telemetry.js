import {ValidationError} from '../../errors.js';

const events = new Set(('APP_OPEN LINK_RECEIVED LINK_VALID LINK_INVALID PAIR_SAVED PAIR_SAVE_FAILED PAIR_FAILED FORGOTTEN '
  +'WORK_REQUEST_MANUAL WORK_REQUEST_PUSH WORK_REQUEST_POLL WORK_NO_TOKEN WORK_STARTED WORK_TICK WORK_STALE WORK_SUCCESS WORK_RETRY WORK_FAILED WORK_STOPPED '
  +'FOREGROUND_DENIED PUSH_RECEIVED PUSH_EXPIRED PUSH_REGISTERED PUSH_REGISTRATION_FAILED SOURCE_LOGIN_REQUIRED SOURCE_ACCOUNT_MISMATCH SOURCE_UNVERIFIED SOURCE_ERROR RENDERER_GONE '
  +'PROCESS_START PROCESS_ALIVE PROCESS_EXIT WORK_STATE API PROGRESS HEARTBEAT CANCEL_REQUESTED CANCEL_ACK CANCEL_PENDING').split(' '));
const enums = {
  source_reason:['redirect','http_error','content_type','request_failed','request_timeout','read_canceled','response_read',
    'response_too_large','state_too_large','html_parse','state_script_missing','state_script_ambiguous','user_state','payload_state',
    'state_shape','customer_missing','customer_null','page_navigation','context_lost','native_result','page_timeout'],
  action:['pair','next','start','page','fail','push','stop','capabilities'],phase:['BEGIN','OK','ERROR'],
  issue:['LINK','AUTH','BUSY','HTTP','REDIRECT','RESPONSE','DNS','TIMEOUT','TLS','CONNECT','NETWORK','STORAGE','UNKNOWN','UPGRADE'],
  work_state:['ENQUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED'],
  stage:['requesting','reading','uploading','waiting','finished','canceling'],
  outcome:['canceled','completed','ended','idle']
};
const numbers = {seq:[1,2147483647],page:[1,1000],attempt:[0,100000],duration_ms:[0,86400000],http_status:[0,599],
  stop_reason:[-256,65535],exit_reason:[0,65535],exit_status:[-2147483648,2147483647],importance:[0,10000],dropped_events:[0,2147483647]};
const booleans = ['screen_locked','screen_off','idle','battery_saver','battery_exempt','background_restricted','network_validated'];
const dates = ['event_at','next_run_at','exit_at'];
const ids = ['event_id','process_id','job_id','run_id'];
const allowed = new Set(['event',...Object.keys(enums),...Object.keys(numbers),...booleans,...dates,...ids]);
export const mobileId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function phoneEvent(value) {
  const bad = () => {throw new ValidationError('Некорректное событие диагностики Android.');};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) bad();
  if (!mobileId(value.event_id) || !mobileId(value.process_id) || !events.has(value.event) || !value.event_at || !value.seq) bad();
  const result = {};
  for (const [key,item] of Object.entries(value)) {
    if (item === null && !['event_id','process_id','event','event_at','seq'].includes(key)) continue;
    if (ids.includes(key) && !mobileId(item)) bad();
    if (dates.includes(key) && (typeof item !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(item) || !Number.isFinite(Date.parse(item)))) bad();
    if (numbers[key] && (!Number.isSafeInteger(item) || item<numbers[key][0] || item>numbers[key][1])) bad();
    if (booleans.includes(key) && typeof item !== 'boolean') bad();
    if (enums[key] && !enums[key].includes(item)) bad();
    result[key] = dates.includes(key) ? new Date(item).toISOString() : item;
  }
  return result;
}
export class MobileTelemetry {
  constructor(mobile) {this.mobile = mobile;this.sql = mobile.sql;}
  accept(input) {
    if (!input || Object.keys(input).some(key => key !== 'events') || !Array.isArray(input.events) || input.events.length>50) throw new ValidationError('Ожидается до 50 событий Android.');
    const values = input.events.map(phoneEvent),device = this.sql.prepare('SELECT token_hash FROM mobile_device WHERE id=1').get();
    if (!device) throw new ValidationError('Телефон не подключён.');
    const received = new Date(this.mobile.current()).toISOString();
    this.mobile.db.transaction(() => {
      for (const item of values) this.sql.prepare(`INSERT OR IGNORE INTO mobile_phone_events(device_hash,event_id,event_at,received_at,job_id,run_id,event,data)
        VALUES(?,?,?,?,?,?,?,?)`).run(device.token_hash,item.event_id,item.event_at,received,item.job_id ?? null,item.run_id ?? null,item.event,JSON.stringify(item));
      this.sql.prepare('DELETE FROM mobile_phone_events WHERE received_at<? OR id <= (SELECT MAX(id)-10000 FROM mobile_phone_events)')
        .run(new Date(this.mobile.current()-14*86400000).toISOString());
    });
    return {ack:values.map(item => item.event_id),received_at:received};
  }
  timeline(job = null) {
    const phone = this.sql.prepare(`SELECT event_id,event_at,received_at,job_id,run_id,event,data FROM mobile_phone_events ${job ? `WHERE job_id=? OR (job_id IS NULL AND run_id IN
      (SELECT id FROM mobile_runs WHERE check_id=(SELECT check_id FROM mobile_job_links WHERE job_id=?)))` : ''} ORDER BY event_at DESC,id DESC LIMIT 150`).all(...(job ? [job,job] : []))
      .map(row => ({...JSON.parse(row.data),source:'phone',received_at:row.received_at}));
    const server = this.sql.prepare(`SELECT id,job_id,event,at,page,reason,screen_locked,screen_off FROM mobile_diagnostics ${job ? 'WHERE job_id=?' : ''} ORDER BY id DESC LIMIT 80`).all(...(job ? [job] : []))
      .map(row => ({...row,event_id:'server:'+row.id,source:'server',event_at:row.at,received_at:row.at}));
    return [...phone,...server].sort((a,b) => b.event_at.localeCompare(a.event_at) || b.received_at.localeCompare(a.received_at)).slice(0,200);
  }
  runtime() {
    const job = this.sql.prepare('SELECT j.id,j.expires,j.next_page,j.status,c.status AS check_status FROM mobile_jobs j JOIN checks c ON c.id=j.check_id ORDER BY j.rowid DESC LIMIT 1').get();
    if (!job) return {state:'idle',job_id:null,last_contact:null,stage:null};
    const direct = this.sql.prepare("SELECT MAX(at) AS at FROM mobile_diagnostics WHERE job_id=? AND event IN ('phone_contact','page_received')").get(job.id).at;
    // Uploaded backlog is evidence of the past, not a fresh heartbeat.
    const heartbeat = this.sql.prepare("SELECT event_at,data FROM mobile_phone_events WHERE job_id=? AND event IN ('HEARTBEAT','PROGRESS') ORDER BY event_at DESC LIMIT 1").get(job.id);
    const heartbeatAt = heartbeat && Math.abs(this.mobile.current()-Date.parse(heartbeat.event_at))<=90000 ? heartbeat.event_at : null;
    const contact = [direct,heartbeatAt].filter(Boolean).sort().at(-1) ?? null;
    const canceled = this.sql.prepare("SELECT 1 FROM mobile_runs WHERE check_id=(SELECT check_id FROM mobile_jobs WHERE id=?) AND state='canceled' LIMIT 1").get(job.id);
    const timedOut = this.sql.prepare("SELECT 1 FROM mobile_diagnostics WHERE job_id=? AND event IN ('no_response','expired') LIMIT 1").get(job.id);
    const state = job.check_status === 'success' ? 'completed' : job.check_status === 'error' ? 'failed'
      : canceled ? 'canceled' : timedOut || job.expires <= this.mobile.current() && job.check_status === 'running' ? 'expired'
      : job.check_status !== 'running' ? 'ended'
      : !contact ? 'waiting' : this.mobile.current()-Date.parse(contact)>90000 ? 'silent' : 'running';
    return {state,job_id:job.id,next_page:job.next_page,last_contact:contact,expires:job.expires,
      stage:heartbeat ? JSON.parse(heartbeat.data).stage ?? null : null};
  }
}
