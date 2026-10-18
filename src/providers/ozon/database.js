import {existsSync, mkdirSync, realpathSync, chmodSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ValidationError} from '../../errors.js';
import {ozonProduct} from './url.js';

export const itemId = sku => 'ozon:item:' + sku;
export function itemSku(value) {
  if (typeof value !== 'string' || !/^ozon:item:[1-9]\d{0,19}$/.test(value)) throw new ValidationError('Некорректный товар Ozon.');
  return value.slice('ozon:item:'.length);
}
const invalid = () => new ValidationError('Хранилище Ozon недоступно. База Randewoo не изменена.');
const lists = ['watching', 'favorites', 'cart'];

export class OzonDatabase {
  constructor(root) {
    const directory = join(resolve(root), '.data/ozon');
    mkdirSync(directory, {recursive:true,mode:0o700});
    const path = join(directory, 'prices.sqlite3');
    if (existsSync(path)) {
      if (dirname(realpathSync(path)) !== realpathSync(directory)) throw invalid();
      let existing;
      try {
        existing = new DatabaseSync(path, {readOnly:true});
        const meta = existing.prepare('SELECT provider,version FROM ozon_meta WHERE id=1').get();
        if (meta?.provider !== 'ozon-prices' || meta.version !== 1 || existing.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw invalid();
      } catch {throw invalid();} finally {existing?.close();}
    }
    this.path = path;
    this.db = new DatabaseSync(path, {timeout:1000});
    try {
      chmodSync(path,0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS ozon_meta(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT NOT NULL,version INTEGER NOT NULL,context_digest TEXT);
        INSERT OR IGNORE INTO ozon_meta VALUES(1,'ozon-prices',1,NULL);
        CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY,url TEXT NOT NULL,title TEXT NOT NULL,image_url TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS membership(sku TEXT NOT NULL REFERENCES products(sku),list TEXT NOT NULL CHECK(list IN ('watching','favorites','cart')),quantity INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sku,list));
        CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY,trigger TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,total INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,check_id INTEGER NOT NULL REFERENCES checks(id),sku TEXT NOT NULL REFERENCES products(sku),checked_at TEXT NOT NULL,status TEXT NOT NULL,availability TEXT,regular_kopecks INTEGER,ozon_card_kopecks INTEGER,seller_id TEXT,seller_name TEXT,message TEXT NOT NULL DEFAULT '',UNIQUE(check_id,sku));
        CREATE INDEX IF NOT EXISTS observations_product ON observations(sku,id DESC);
        CREATE TABLE IF NOT EXISTS list_snapshots(check_id INTEGER NOT NULL REFERENCES checks(id),list TEXT NOT NULL CHECK(list IN ('watching','favorites','cart')),sku TEXT NOT NULL REFERENCES products(sku),quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(check_id,list,sku));
        CREATE TABLE IF NOT EXISTS seller_events(id INTEGER PRIMARY KEY,sku TEXT NOT NULL REFERENCES products(sku),checked_at TEXT NOT NULL,old_id TEXT NOT NULL,new_id TEXT NOT NULL,old_name TEXT,new_name TEXT);
        CREATE TABLE IF NOT EXISTS collector_state(id INTEGER PRIMARY KEY CHECK(id=1),schedule_enabled INTEGER NOT NULL DEFAULT 0,next_check TEXT,not_before TEXT,action_required INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '');
        INSERT OR IGNORE INTO collector_state(id) VALUES(1);`);
      if (!this.db.prepare('PRAGMA table_info(observations)').all().some(column => column.name === 'source')) this.db.exec("ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'http'");
    } catch (error) {this.db.close(); throw error;}
  }
  close() {this.db.close();}
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = action(); this.db.exec('COMMIT'); return result;} catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  bindContext(digest) {
    const previous = this.db.prepare('SELECT context_digest FROM ozon_meta WHERE id=1').get().context_digest;
    if (previous && previous !== digest) throw new ValidationError('Аккаунт или адрес Ozon изменился. Требуется отдельная история для нового подключения.');
    this.db.prepare('UPDATE ozon_meta SET context_digest=? WHERE id=1').run(digest);
  }
  product(sku) {return this.db.prepare('SELECT * FROM products WHERE sku=?').get(sku);}
  upsert(product, now) {
    const parsed = ozonProduct(product.url);
    if (parsed.external_id !== product.external_id || !product.title || product.title.length > 2000) throw invalid();
    this.db.prepare(`INSERT INTO products(sku,url,title,image_url,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(sku) DO UPDATE SET url=excluded.url,title=excluded.title,image_url=COALESCE(excluded.image_url,products.image_url)`)
      .run(parsed.external_id, parsed.url, product.title, product.image_url || null, now);
  }
  watch(url, active = true, now = new Date().toISOString()) {
    const product = ozonProduct(url), sku = product.external_id;
    if (!this.product(sku)) this.upsert({...product, title:'Товар Ozon · ' + sku}, now);
    if (active) this.db.prepare("INSERT OR IGNORE INTO membership(sku,list) VALUES(?,'watching')").run(sku);
    else this.db.prepare("DELETE FROM membership WHERE sku=? AND list='watching'").run(sku);
    return itemId(sku);
  }
  syncLists(favorites, cart, now) {
    this.transaction(() => {
      for (const [list, items] of [['favorites',favorites],['cart',cart]]) {
        this.db.prepare('DELETE FROM membership WHERE list=?').run(list);
        for (const [position, product] of items.entries()) {
          this.upsert(product, now);
          this.db.prepare('INSERT INTO membership(sku,list,quantity,position) VALUES(?,?,?,?)').run(product.external_id,list,product.quantity || 1,position);
        }
      }
    });
  }
  targets() {return this.db.prepare('SELECT DISTINCT p.* FROM products p JOIN membership m ON m.sku=p.sku ORDER BY p.created_at,p.sku LIMIT 101').all();}
  snapshotLists(check) {
    this.db.prepare('INSERT INTO list_snapshots(check_id,list,sku,quantity) SELECT ?,list,sku,quantity FROM membership').run(check);
  }
  state() {return this.db.prepare('SELECT * FROM collector_state WHERE id=1').get();}
  updateState({schedule_enabled,next_check,not_before,action_required,message}) {
    const fields = {schedule_enabled,next_check,not_before,action_required,message};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) this.db.prepare(`UPDATE collector_state SET ${key}=? WHERE id=1`).run(value);
  }
  checks() {return this.db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 10').all();}
  recover(now) {
    const count = this.db.prepare("UPDATE checks SET status='interrupted',finished_at=?,message='Проверка прервана. Требуется проверить подключение.' WHERE status='running'").run(now).changes;
    if (count) this.updateState({action_required:1,message:'Предыдущая проверка Ozon прервана.'});
  }
  begin(trigger, now) {return Number(this.db.prepare("INSERT INTO checks(trigger,status,started_at) VALUES(?,'running',?)").run(trigger,now).lastInsertRowid);}
  progress(check, total) {this.db.prepare('UPDATE checks SET total=? WHERE id=?').run(total,check);}
  finish(check, status, message, now) {this.db.prepare('UPDATE checks SET status=?,message=?,finished_at=? WHERE id=?').run(status,message,now,check);}
  observe(check, product, now, source = 'http') {
    if (!['http','browser'].includes(source)) throw invalid();
    this.transaction(() => {
      this.upsert(product, now);
      const old = this.db.prepare("SELECT seller_id,seller_name FROM observations WHERE sku=? AND status='ok' AND seller_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(product.external_id);
      const seller = product.seller;
      if (old?.seller_id && seller.external_id && old.seller_id !== seller.external_id) this.db.prepare('INSERT INTO seller_events(sku,checked_at,old_id,new_id,old_name,new_name) VALUES(?,?,?,?,?,?)')
        .run(product.external_id,now,old.seller_id,seller.external_id,old.seller_name,seller.name);
      this.db.prepare(`INSERT INTO observations(check_id,sku,checked_at,status,availability,regular_kopecks,ozon_card_kopecks,seller_id,seller_name,source) VALUES(?,?,?,'ok',?,?,?,?,?,?)`)
        .run(check,product.external_id,now,product.availability,product.prices.regular_kopecks,product.prices.ozon_card_kopecks,seller.external_id,seller.name,source);
      this.db.prepare('UPDATE checks SET completed=completed+1 WHERE id=?').run(check);
    });
  }
  failure(check, sku, message, now) {
    this.db.prepare("INSERT OR IGNORE INTO observations(check_id,sku,checked_at,status,message) VALUES(?,?,?,'error',?)").run(check,sku,now,message);
  }
  row(product) {
    const latest = this.db.prepare('SELECT * FROM observations WHERE sku=? ORDER BY id DESC LIMIT 1').get(product.sku);
    const price = this.db.prepare("SELECT * FROM observations WHERE sku=? AND status='ok' ORDER BY id DESC LIMIT 1").get(product.sku);
    const seller = this.db.prepare("SELECT seller_id,seller_name FROM observations WHERE sku=? AND status='ok' AND seller_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(product.sku);
    const event = this.db.prepare('SELECT checked_at,old_name,new_name FROM seller_events WHERE sku=? ORDER BY id DESC LIMIT 1').get(product.sku);
    return {...product,id:itemId(product.sku),status:latest?.status || 'pending',checked_at:latest?.checked_at || null,
      price_at:price?.checked_at || null,regular_kopecks:price?.regular_kopecks ?? null,ozon_card_kopecks:price?.ozon_card_kopecks ?? null,
      availability:price?.availability || 'unknown',seller_id:seller?.seller_id || null,seller_name:seller?.seller_name || null,
      seller_change:event || null,message:latest?.message || '',lists:this.db.prepare('SELECT list,quantity FROM membership WHERE sku=?').all(product.sku),
      sparkline:this.db.prepare('SELECT checked_at,status,availability,regular_kopecks,ozon_card_kopecks,seller_id,message FROM observations WHERE sku=? ORDER BY id DESC LIMIT 24').all(product.sku).reverse()};
  }
  dashboard(list = 'watching') {
    if (!lists.includes(list)) throw new ValidationError('Неизвестный список Ozon.');
    const items = this.db.prepare('SELECT p.* FROM products p JOIN membership m ON m.sku=p.sku WHERE m.list=? ORDER BY m.position,p.created_at DESC').all(list).map(product => this.row(product));
    const counts = Object.fromEntries(lists.map(name => [name,Number(this.db.prepare('SELECT COUNT(*) AS n FROM membership WHERE list=?').get(name).n)]));
    return {items,counts,list,history:this.listHistory(list)};
  }
  listHistory(list, days = 30, now = Date.now()) {
    if (!lists.includes(list)) throw new ValidationError('Неизвестный список Ozon.');
    const since = days ? new Date(now-days*86400000).toISOString() : '';
    const rows = this.db.prepare(`SELECT s.check_id,s.sku,s.quantity,c.finished_at,o.checked_at,o.status,o.availability,
      o.regular_kopecks,o.ozon_card_kopecks,o.seller_id,o.message
      FROM list_snapshots s JOIN checks c ON c.id=s.check_id
      LEFT JOIN observations o ON o.check_id=s.check_id AND o.sku=s.sku
      WHERE s.list=? AND c.status<>'running' AND c.finished_at>=? ORDER BY c.finished_at,c.id,s.sku`).all(list,since);
    const runs = new Map();
    for (const row of rows) {
      if (!runs.has(row.check_id)) runs.set(row.check_id,[]);
      runs.get(row.check_id).push(row);
    }
    return [...runs.values()].filter(members => members.some(row => row.checked_at)).map(members => {
      const failed = members.filter(row => row.status === 'error');
      const point = {checked_at:members[0].finished_at,count:members.length,observed_count:members.filter(row => row.checked_at).length,
        message:[...new Set(failed.map(row => row.message).filter(Boolean))].join('; ')};
      for (const price of ['regular','ozon_card']) {
        const column = price+'_kopecks';
        const known = members.filter(row => row.status === 'ok' && row.availability === 'available' && row[column] != null);
        const complete = known.length === members.length;
        point[price] = {known_total:known.reduce((sum,row) => sum+row[column]*row.quantity,0),priced_count:known.length,complete,
          status:failed.length ? 'error' : complete ? 'ok' : 'missing',
          composition:JSON.stringify([members.map(row => [row.sku,row.quantity]),known.map(row => [row.sku,row.seller_id])])};
      }
      return point;
    });
  }
  detail(id, days = 30, now = Date.now()) {
    const sku = itemSku(id), product = this.product(sku);
    if (!product || ![0,7,30,90,365].includes(days)) throw new ValidationError('Товар или период Ozon не найден.');
    const since = days ? new Date(now-days*86400000).toISOString() : '';
    const points = this.db.prepare('SELECT checked_at,status,availability,regular_kopecks,ozon_card_kopecks,seller_id,seller_name,message,source FROM observations WHERE sku=? AND checked_at>=? ORDER BY id DESC LIMIT 2000').all(sku,since).reverse();
    const seller_events = this.db.prepare('SELECT checked_at,old_name,new_name FROM seller_events WHERE sku=? AND checked_at>=? ORDER BY id DESC LIMIT 2000').all(sku,since).reverse();
    return {product:this.row(product),points,seller_events};
  }
}
