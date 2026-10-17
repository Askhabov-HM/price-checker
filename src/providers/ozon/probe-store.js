import {existsSync, mkdirSync, realpathSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ValidationError} from '../../errors.js';
import {OZON_INTERVAL_MS} from './probe.js';

const VERSION = 1;
const outcomes = new Set(['network_error', 'rate_limited', 'login_required', 'access_limited', 'redirect', 'http_error',
  'unexpected_content', 'response_too_large', 'html_received', 'json_received', 'account_mismatch', 'delivery_mismatch', 'incomplete_data']);
const signalKeys = ['access_limited', 'login_required', 'product_heading', 'bank_price_label', 'other_banks_label', 'ozon_card_label',
  'redirect_location_present', 'redirect_location_valid', 'redirect_same_origin', 'redirect_same_path', 'redirect_query_changed',
  'account_verified', 'delivery_verified', 'favorites_complete'];
const safeSignals = signals => Object.fromEntries(signalKeys.filter(key => typeof signals?.[key] === 'boolean').map(key => [key, signals[key]]));
const stamp = value => new Date(value).toISOString();
const invalidDatabase = () => new ValidationError('Файл не является поддерживаемой диагностической базой Ozon. Другие базы не изменены.');

export function ozonProbePaths(root) {
  const directory = join(resolve(root), '.data', 'ozon');
  return {directory, database: join(directory, 'probe.sqlite3'), lock: join(directory, 'probe.lock')};
}

function validateExisting(path) {
  let db;
  try {
    // Inspect before journal_mode, migrations or other writes to a possibly foreign database.
    db = new DatabaseSync(path, {readOnly: true});
    const row = db.prepare('SELECT provider,schema_version FROM probe_meta WHERE id=1').get();
    if (row?.provider !== 'ozon-probe' || row.schema_version !== VERSION) throw invalidDatabase();
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw invalidDatabase();
  } catch {throw invalidDatabase();}
  finally {db?.close();}
}

// Experimental state is deliberately separate even from the future Ozon price database.
export class OzonProbeStore {
  #pending = false;
  constructor(path) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), {recursive: true});
    if (existsSync(absolute)) {
      if (!statSync(absolute).isFile()) throw invalidDatabase();
      validateExisting(absolute);
    }
    const parent = realpathSync(dirname(absolute));
    if (existsSync(absolute) && dirname(realpathSync(absolute)) !== parent) throw invalidDatabase();
    this.path = absolute;
    this.db = new DatabaseSync(absolute, {timeout: 1000});
    try {
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS probe_meta(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT NOT NULL,schema_version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS access_state(id INTEGER PRIMARY KEY CHECK(id=1),not_before TEXT,action_required INTEGER NOT NULL DEFAULT 0,
          reason TEXT,rate_limits INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS probes(id INTEGER PRIMARY KEY,checked_at TEXT NOT NULL,target_kind TEXT NOT NULL,
          external_id TEXT,http_status INTEGER,outcome TEXT NOT NULL,body_bytes INTEGER NOT NULL,signals TEXT NOT NULL);
        INSERT OR IGNORE INTO probe_meta VALUES(1,'ozon-probe',1);
        INSERT OR IGNORE INTO access_state(id) VALUES(1);`);
    } catch (error) {this.db.close(); throw error;}
  }

  close() {this.db.close();}

  status(current = Date.now()) {
    const state = this.db.prepare('SELECT not_before,action_required,reason,rate_limits FROM access_state WHERE id=1').get();
    const last = this.db.prepare('SELECT checked_at,target_kind,external_id,http_status,outcome,body_bytes,signals FROM probes ORDER BY id DESC LIMIT 1').get() || null;
    if (last) {
      try {last.signals = safeSignals(JSON.parse(last.signals));} catch {last.signals = {};}
    }
    return {provider: 'ozon', scope: 'transport_probe', schema_version: VERSION, city: 'Грозный', interval_minutes: 120,
      account_connected: false, collector_enabled: false, ...state, action_required: Boolean(state.action_required),
      allowed: !state.action_required && (!state.not_before || Date.parse(state.not_before) <= current),
      last_probe: last};
  }

  assertAllowed(current = Date.now()) {
    if (!this.status(current).allowed) throw new ValidationError('Проверка Ozon приостановлена. Сначала проверьте статус и причину паузы.');
  }

  beginAttempt(current = Date.now()) {
    this.assertAllowed(current);
    // Reserve before sending anything. A killed process leaves a durable pause,
    // rather than silently treating an unrecorded request as never having happened.
    this.db.prepare('UPDATE access_state SET not_before=?,action_required=1,reason=? WHERE id=1')
      .run(stamp(Math.min(current + OZON_INTERVAL_MS, 8.64e15)), 'interrupted_attempt');
    this.#pending = true;
  }

  acknowledge(current = Date.now()) {
    const state = this.status(current);
    if (state.not_before && Date.parse(state.not_before) > current) throw new ValidationError('Срок ожидания Ozon ещё не истёк. Пауза сохраняется.');
    this.db.prepare('UPDATE access_state SET action_required=0,reason=NULL WHERE id=1').run();
    return this.status(current);
  }

  record(result, current = Date.now()) {
    if (!outcomes.has(result?.outcome) || !['home', 'product', 'cart', 'favorites'].includes(result.target_kind)
      || !Number.isFinite(Date.parse(result.checked_at)) || !Number.isSafeInteger(result.body_bytes) || result.body_bytes < 0
      || result.http_status !== null && (!Number.isInteger(result.http_status) || result.http_status < 100 || result.http_status > 599)
      || result.external_id !== null && (typeof result.external_id !== 'string' || !/^[1-9]\d{0,19}$/.test(result.external_id))) throw new ValidationError('Некорректный результат диагностики Ozon');
    if (!this.#pending) this.assertAllowed(current);
    const signals = safeSignals(result.signals);
    const old = this.status(current);
    const rateLimits = result.outcome === 'rate_limited' ? old.rate_limits + 1 : old.rate_limits;
    const transient = ['network_error', 'http_error'].includes(result.outcome);
    const preceding = this.db.prepare('SELECT outcome FROM probes ORDER BY id DESC LIMIT 2').all();
    let failures = transient ? 1 : 0;
    if (transient) for (const row of preceding) {
      if (!['network_error', 'http_error'].includes(row.outcome)) break;
      failures++;
    }
    const action = ['redirect', 'access_limited', 'login_required', 'unexpected_content', 'response_too_large',
      'account_mismatch', 'delivery_mismatch', 'incomplete_data'].includes(result.outcome) || failures >= 3
      || result.outcome === 'rate_limited' && rateLimits > 1;
    const retry = Number.isSafeInteger(result.retry_after_ms) && result.retry_after_ms > 0 ? result.retry_after_ms : 0;
    const backoff = result.outcome === 'rate_limited' ? 3 : transient ? 2 ** (failures - 1) : 1;
    const wait = Math.min(Math.max(OZON_INTERVAL_MS * backoff, retry), 8.64e15 - current);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO probes(checked_at,target_kind,external_id,http_status,outcome,body_bytes,signals) VALUES(?,?,?,?,?,?,?)`)
        .run(stamp(Date.parse(result.checked_at)), result.target_kind, result.external_id, result.http_status, result.outcome, result.body_bytes, JSON.stringify(signals));
      this.db.prepare('UPDATE access_state SET not_before=?,action_required=?,reason=?,rate_limits=? WHERE id=1')
        .run(stamp(current + wait), Number(action), ['html_received', 'json_received'].includes(result.outcome) ? 'interval' : result.outcome, rateLimits);
      this.db.exec('COMMIT');
      this.#pending = false;
    } catch (error) {this.db.exec('ROLLBACK'); throw error;}
    return this.status(current);
  }
}
