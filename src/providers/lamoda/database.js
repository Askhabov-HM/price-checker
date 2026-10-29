import {migrateLamoda} from '../../storage-schema.js';
import {mkdirSync, existsSync, realpathSync, chmodSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CollectionSnapshot} from '../../collection-snapshot.js';
import {randomUUID, createHash} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {validSku} from './parser.js';
import {HistoryCache,RowCache,compositionKey,emptySummary,recordPrice,publicSummary,appendSparkline} from '../../dashboard-cache.js';

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
    try {migrateLamoda(this.db);
      this.rowCache = new RowCache(this.db,{key:'sku',initial:() => ({latest:null,good:null,summary:emptySummary(),sparkline:[]}),
        reduce:(state,row) => {
          state.latest = row;
          if (row.status === 'ok') {
            state.good = row;
            if (row.price != null && row.availability !== 'unavailable') recordPrice(state.summary,row.price,row.price_at);
          }
          appendSparkline(state,row);
        }});
      this.historyCache = new HistoryCache(this.db,{scopes:['favorites'],order:'position',
        sources:[{table:'observations',event:row => `'c:'||${row}.check_id`},{table:'checks',event:row => `'c:'||${row}.id`}]});
      this.published = new CollectionSnapshot(this.db,{scopes:['favorites'],build:() => this.dashboard()});
    } catch(error) {this.db.close();throw error;}
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
  begin(trigger,now) {return this.published.start(() => Number(this.db.prepare("INSERT INTO checks(event_id,trigger,status,started_at) VALUES(?,?,'running',?)").run(randomUUID(),trigger,now).lastInsertRowid));}
  checks() {return this.db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 20').all();}
  latest(sku,status = false) {return this.db.prepare('SELECT * FROM observations WHERE sku=?'+(status ? " AND status='ok'" : '')+' ORDER BY id DESC LIMIT 1').get(sku);}
  lastKnown(sku) {return this.db.prepare("SELECT * FROM observations WHERE sku=? AND status='ok' AND price IS NOT NULL ORDER BY id DESC LIMIT 1").get(sku);}
  finish(check,status,message,now,{down = 0,up = 0} = {}) {
    this.db.prepare('UPDATE checks SET status=?,message=?,finished_at=?,down=?,up=? WHERE id=?').run(status,message,now,down,up,check);
    const row = this.db.prepare('SELECT * FROM checks WHERE id=?').get(check);
    const kind = status === 'success' ? 'success' : message === 'Нужен повторный вход в Lamoda.' ? 'login' : 'error';
    const previous = this.db.prepare('SELECT * FROM notification_state WHERE id=1').get();
    const payload = {store:'lamoda',kind,down,up,finishedAt:now,recovered:kind === 'success' && !!previous.kind && previous.kind !== 'success'};
    this.db.prepare('INSERT OR IGNORE INTO telegram_outbox(event_id,check_id,payload) VALUES(?,?,?)').run(row.event_id,check,JSON.stringify(payload));
    this.db.prepare('UPDATE notification_state SET kind=?,reason=? WHERE id=1').run(kind,message);
    this.historyCache.refreshAll((scope,events) => this.buildListHistory(events));
  }
  record(check,items,now,source = 'browser') {
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
        this.db.prepare("INSERT INTO observations(check_id,sku,checked_at,price_at,price,original_price,availability,status,source) VALUES(?,?,?,?,?,?,?,'ok',?)")
          .run(check,item.sku,now,priceAt,price,original,item.availability,source);
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
    return publicSummary(this.rowCache.read([sku]).get(String(sku)).summary);
  }
  row(product, state = null) {
    const {latest,good,summary,sparkline} = state || this.rowCache.read([product.sku]).get(String(product.sku));
    return {...product,id:'lamoda:item:'+product.sku,status:latest?.status || 'pending',checked_at:latest?.checked_at ?? null,
      price:good?.price ?? null,original_price:good?.original_price ?? null,price_at:good?.price_at ?? null,
      availability:good?.availability ?? 'unknown',message:latest?.message || '',...publicSummary(summary),sparkline:sparkline.map(this.point)};
  }
  point(point) {return {...point,in_stock:point.availability === 'unknown' ? null : point.availability === 'available'};}
  dashboard() {
    const products = this.db.prepare('SELECT * FROM products WHERE active=1 ORDER BY position').all();
    const states = this.rowCache.read(products.map(product => product.sku));
    const items = products.map(product => this.row(product,states.get(product.sku)));
    const history = this.historyCache.read('favorites',new Date(Date.now()-30*86400000).toISOString(),events => this.buildListHistory(events));
    return {items,history};
  }
  buildListHistory(events = null) {
    const checks = this.db.prepare(`SELECT * FROM checks WHERE status<>'running' AND finished_at IS NOT NULL
      ${events === null ? '' : 'AND id IN (SELECT substr(value,3) FROM json_each(?))'} ORDER BY id`).all(...(events === null ? [] : [JSON.stringify(events)]));
    const grouped = new Map(checks.map(check => [check.id,[]]));
    for (const row of this.db.prepare(`SELECT check_id,sku,status,availability,price FROM observations
      WHERE check_id IN (SELECT value FROM json_each(?)) ORDER BY check_id,sku`).all(JSON.stringify(checks.map(check => check.id)))) grouped.get(row.check_id).push(row);
    return checks.map(check => {
      const rows = grouped.get(check.id);
      const known = rows.filter(row => row.status === 'ok' && row.availability === 'available' && row.price !== null);
      const complete = known.length === rows.length;
      return {key:'c:'+check.id,stamp:check.finished_at,position:check.id,point:{checked_at:check.finished_at,price:known.length ? known.reduce((sum,row) => sum+row.price,0) : null,
        status:check.status !== 'success' ? 'error' : complete ? 'ok' : 'missing',count:rows.length,priced_count:known.length,complete,
        composition:compositionKey([rows.map(row => row.sku),known.map(row => row.sku)]),message:check.message}};
    });
  }
  publishedDashboard() {return this.published.dashboard('favorites');}
  publishedDetail(id,days) {return this.published.detail(id,boundary => this.detail(id,days,boundary));}
  detail(id,days = 30,{maxId,product:savedProduct} = {}) {
    const sku = typeof id === 'string' && id.startsWith('lamoda:item:') ? id.slice(12) : '';
    if (!validSku(sku) || ![0,7,30,90,365].includes(days)) throw new ValidationError('Некорректный товар или период Lamoda.');
    const product = this.db.prepare('SELECT * FROM products WHERE sku=?').get(sku);
    if (!product) throw new ValidationError('Товар Lamoda не найден.');
    return {product:savedProduct || this.row(product),points:this.db.prepare('SELECT * FROM observations WHERE sku=? AND checked_at>=?'+(maxId === undefined ? '' : ' AND id<=?')+' ORDER BY id DESC LIMIT 5000')
      .all(sku,days ? new Date(Date.now()-days*86400000).toISOString() : '',...(maxId === undefined ? [] : [maxId])).reverse().map(this.point)};
  }
  pending(now = Date.now()) {return this.db.prepare('SELECT * FROM telegram_outbox WHERE delivered_at IS NULL AND next_attempt_ms<=? ORDER BY check_id LIMIT 20').all(now);}
  delivered(event,messageId,now) {this.db.prepare('UPDATE telegram_outbox SET delivered_at=?,message_id=? WHERE event_id=?').run(now,messageId ?? null,event);}
  retry(event,at) {this.db.prepare('UPDATE telegram_outbox SET attempts=attempts+1,next_attempt_ms=? WHERE event_id=?').run(at,event);}
}
