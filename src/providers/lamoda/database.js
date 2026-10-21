import {mkdirSync, existsSync, realpathSync, chmodSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID, createHash} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {validSku} from './parser.js';

const accountDigest = account => createHash('sha256').update('lamoda:'+account).digest('hex');
export class LamodaDatabase {
  constructor(root) {
    const directory = join(resolve(root),'.data/lamoda'); mkdirSync(directory,{recursive:true,mode:0o700});
    this.path = join(directory,'prices.sqlite3');
    if (existsSync(this.path)) {
      if (dirname(realpathSync(this.path)) !== realpathSync(directory)) throw new ValidationError('Неверный путь базы Lamoda.');
      const existing = new DatabaseSync(this.path,{readOnly:true});
      try {const meta = existing.prepare('SELECT provider,version FROM lamoda_meta WHERE id=1').get();
        if (meta?.provider !== 'lamoda-prices' || meta.version !== 1) throw new Error();
      } catch {throw new ValidationError('Хранилище Lamoda недоступно.');} finally {existing.close();}
    }
    this.db = new DatabaseSync(this.path,{timeout:1000}); chmodSync(this.path,0o600);
    try {this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS lamoda_meta(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT NOT NULL,version INTEGER NOT NULL,account_digest TEXT);
      INSERT OR IGNORE INTO lamoda_meta VALUES(1,'lamoda-prices',1,NULL);
      CREATE TABLE IF NOT EXISTS collector_state(id INTEGER PRIMARY KEY CHECK(id=1),schedule_enabled INTEGER NOT NULL DEFAULT 0,
        schedule_mode TEXT NOT NULL DEFAULT 'interval',schedule TEXT NOT NULL DEFAULT '[]',interval_minutes INTEGER NOT NULL DEFAULT 30,
        schedule_anchor TEXT,next_check TEXT,not_before TEXT,action_required INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '');
      INSERT OR IGNORE INTO collector_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY,title TEXT NOT NULL,color TEXT NOT NULL,url TEXT NOT NULL,image_url TEXT,position INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,trigger TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,
        total INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',down INTEGER NOT NULL DEFAULT 0,up INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,check_id INTEGER NOT NULL REFERENCES checks(id),sku TEXT NOT NULL REFERENCES products(sku),
        checked_at TEXT NOT NULL,price_at TEXT,price INTEGER,original_price INTEGER,availability TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'browser',
        UNIQUE(check_id,sku));
      CREATE INDEX IF NOT EXISTS lamoda_observations_product ON observations(sku,id DESC);
      CREATE TABLE IF NOT EXISTS telegram_outbox(event_id TEXT PRIMARY KEY,check_id INTEGER NOT NULL REFERENCES checks(id),payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,message_id INTEGER);
      CREATE TABLE IF NOT EXISTS notification_state(id INTEGER PRIMARY KEY CHECK(id=1),kind TEXT,reason TEXT);
      INSERT OR IGNORE INTO notification_state(id) VALUES(1);`);} catch(error) {this.db.close();throw error;}
  }
  close() {this.db.close();}
  transaction(action) {this.db.exec('BEGIN IMMEDIATE');try {const value = action();this.db.exec('COMMIT');return value;} catch(error) {this.db.exec('ROLLBACK');throw error;}}
  state() {return this.db.prepare('SELECT * FROM collector_state WHERE id=1').get();}
  configured() {return !!this.db.prepare('SELECT account_digest FROM lamoda_meta WHERE id=1').get().account_digest;}
  accountDigest() {return this.db.prepare('SELECT account_digest FROM lamoda_meta WHERE id=1').get().account_digest;}
  bindAccount(account) {
    if (!/^\d{1,20}$/.test(account)) throw new ValidationError('Аккаунт Lamoda не подтверждён.');
    const digest = accountDigest(account), previous = this.db.prepare('SELECT account_digest FROM lamoda_meta WHERE id=1').get().account_digest;
    if (previous && previous !== digest) throw new ValidationError('Открыт другой аккаунт Lamoda. История сохранена.');
    this.db.prepare('UPDATE lamoda_meta SET account_digest=? WHERE id=1').run(digest);
  }
  matches(account) {return /^\d{1,20}$/.test(account) && this.db.prepare('SELECT account_digest FROM lamoda_meta WHERE id=1').get().account_digest === accountDigest(account);}
  updateState(fields) {
    const allowed = new Set(['schedule_enabled','schedule_mode','schedule','interval_minutes','schedule_anchor','next_check','not_before','action_required','message']);
    for (const [name,value] of Object.entries(fields)) if (allowed.has(name) && value !== undefined) this.db.prepare(`UPDATE collector_state SET ${name}=? WHERE id=1`).run(value);
  }
  begin(trigger,now) {return Number(this.db.prepare("INSERT INTO checks(event_id,trigger,status,started_at) VALUES(?,?,'running',?)").run(randomUUID(),trigger,now).lastInsertRowid);}
  checks() {return this.db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 20').all();}
  latest(sku,status = false) {return this.db.prepare('SELECT * FROM observations WHERE sku=?'+(status ? " AND status='ok'" : '')+' ORDER BY id DESC LIMIT 1').get(sku);}
  lastKnown(sku) {return this.db.prepare("SELECT * FROM observations WHERE sku=? AND status='ok' AND price IS NOT NULL ORDER BY id DESC LIMIT 1").get(sku);}
  finish(check,status,message,now,{down = 0,up = 0} = {}) {
    this.db.prepare('UPDATE checks SET status=?,message=?,finished_at=?,down=?,up=? WHERE id=?').run(status,message,now,down,up,check);
    const row = this.db.prepare('SELECT * FROM checks WHERE id=?').get(check);
    const kind = status === 'success' ? 'success' : message === 'Нужен повторный вход в Lamoda.' ? 'login' : 'error';
    const previous = this.db.prepare('SELECT * FROM notification_state WHERE id=1').get();
    if (kind === 'success' || previous.kind !== kind || previous.reason !== message) {
      const payload = {store:'lamoda',kind,down,up,finishedAt:now,recovered:kind === 'success' && !!previous.kind && previous.kind !== 'success'};
      this.db.prepare('INSERT OR IGNORE INTO telegram_outbox(event_id,check_id,payload) VALUES(?,?,?)').run(row.event_id,check,JSON.stringify(payload));
    }
    this.db.prepare('UPDATE notification_state SET kind=?,reason=? WHERE id=1').run(kind,message);
  }
  record(check,items,now) {
    return this.transaction(() => {
      this.db.prepare('UPDATE products SET active=0').run(); let down = 0,up = 0;
      for (const [position,item] of items.entries()) {
        const previous = this.lastKnown(item.sku), unavailable = item.availability === 'unavailable';
        const price = unavailable ? previous?.price ?? null : item.price;
        const original = unavailable ? previous?.original_price ?? null : item.original_price;
        const priceAt = unavailable ? previous?.price_at ?? null : price === null ? null : now;
        if (!unavailable && price !== null && previous?.price != null) {if (price < previous.price) down++;if (price > previous.price) up++;}
        this.db.prepare(`INSERT INTO products VALUES(?,?,?,?,?,?,1) ON CONFLICT(sku) DO UPDATE SET title=excluded.title,color=excluded.color,url=excluded.url,
          image_url=excluded.image_url,position=excluded.position,active=1`).run(item.sku,item.title,item.color,item.url,item.image_url,position);
        this.db.prepare("INSERT INTO observations(check_id,sku,checked_at,price_at,price,original_price,availability,status) VALUES(?,?,?,?,?,?,?,'ok')")
          .run(check,item.sku,now,priceAt,price,original,item.availability);
      }
      this.db.prepare('UPDATE checks SET total=?,completed=? WHERE id=?').run(items.length,items.length,check);
      this.finish(check,'success',`Избранное обновлено. Товаров: ${items.length}.`,now,{down,up});
      return {down,up};
    });
  }
  failure(check,message,now,status = 'error') {
    this.transaction(() => {
      const products = this.db.prepare('SELECT sku FROM products WHERE active=1').all();
      for (const {sku} of products) this.db.prepare("INSERT INTO observations(check_id,sku,checked_at,availability,status,message) VALUES(?,?,?,'unknown','error',?)").run(check,sku,now,message);
      this.db.prepare('UPDATE checks SET total=?,completed=0 WHERE id=?').run(products.length,check);
      this.finish(check,status,message,now);
    });
  }
  recover(now) {
    for (const row of this.db.prepare("SELECT id FROM checks WHERE status='running'").all()) this.failure(row.id,'Проверка Lamoda прервана.',now,'interrupted');
  }
  summary(sku) {
    const history = this.db.prepare("SELECT * FROM observations WHERE sku=? AND status='ok' AND price IS NOT NULL ORDER BY id").all(sku);
    let previous = null,minimum = null,last_change = null,observations = 0;
    for (const point of history) {
      if (point.availability === 'unavailable') continue;
      minimum = minimum === null ? point.price : Math.min(minimum,point.price); observations++;
      if (previous !== null && previous !== point.price) last_change = {checked_at:point.price_at,previous_price:previous,price:point.price,delta:point.price-previous};
      previous = point.price;
    }
    return {minimum,last_change,observations};
  }
  row(product) {
    const latest = this.latest(product.sku), good = this.latest(product.sku,true);
    return {...product,id:'lamoda:item:'+product.sku,status:latest?.status || 'pending',checked_at:latest?.checked_at ?? null,
      price:good?.price ?? null,original_price:good?.original_price ?? null,price_at:good?.price_at ?? null,
      availability:good?.availability ?? 'unknown',message:latest?.message || '',...this.summary(product.sku),
      sparkline:this.db.prepare('SELECT * FROM observations WHERE sku=? ORDER BY id DESC LIMIT 24').all(product.sku).reverse().map(this.point)};
  }
  point(point) {return {...point,in_stock:point.availability === 'unknown' ? null : point.availability === 'available'};}
  dashboard() {
    const items = this.db.prepare('SELECT * FROM products WHERE active=1 ORDER BY position').all().map(product => this.row(product));
    const checks = this.db.prepare("SELECT * FROM checks WHERE status<>'running' AND finished_at>=? ORDER BY id").all(new Date(Date.now()-30*86400000).toISOString());
    const history = checks.map(check => {
      const rows = this.db.prepare('SELECT * FROM observations WHERE check_id=? ORDER BY sku').all(check.id);
      const known = rows.filter(row => row.status === 'ok' && row.availability === 'available' && row.price !== null);
      const complete = known.length === rows.length;
      return {checked_at:check.finished_at,price:known.length ? known.reduce((sum,row) => sum+row.price,0) : null,
        status:check.status !== 'success' ? 'error' : complete ? 'ok' : 'missing',count:rows.length,priced_count:known.length,complete,
        composition:JSON.stringify([rows.map(row => row.sku),known.map(row => row.sku)]),message:check.message};
    });
    return {items,history};
  }
  detail(id,days = 30) {
    const sku = typeof id === 'string' && id.startsWith('lamoda:item:') ? id.slice(12) : '';
    if (!validSku(sku) || ![0,7,30,90,365].includes(days)) throw new ValidationError('Некорректный товар или период Lamoda.');
    const product = this.db.prepare('SELECT * FROM products WHERE sku=?').get(sku);
    if (!product) throw new ValidationError('Товар Lamoda не найден.');
    return {product:this.row(product),points:this.db.prepare('SELECT * FROM observations WHERE sku=? AND checked_at>=? ORDER BY id DESC LIMIT 5000')
      .all(sku,days ? new Date(Date.now()-days*86400000).toISOString() : '').reverse().map(this.point)};
  }
  pending(now = Date.now()) {return this.db.prepare('SELECT * FROM telegram_outbox WHERE delivered_at IS NULL AND next_attempt_ms<=? ORDER BY check_id LIMIT 20').all(now);}
  delivered(event,messageId,now) {this.db.prepare('UPDATE telegram_outbox SET delivered_at=?,message_id=? WHERE event_id=?').run(now,messageId ?? null,event);}
  retry(event,at) {this.db.prepare('UPDATE telegram_outbox SET attempts=attempts+1,next_attempt_ms=? WHERE event_id=?').run(at,event);}
}
