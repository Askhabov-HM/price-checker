import {migrateOzon} from '../../storage-schema.js';
import {existsSync, mkdirSync, realpathSync, chmodSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CollectionSnapshot} from '../../collection-snapshot.js';
import {ValidationError} from '../../errors.js';
import {ozonProduct} from './url.js';
import {HistoryCache,RowCache,compositionKey,emptySummary,recordPrice,publicSummary,appendSparkline} from '../../dashboard-cache.js';

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
      migrateOzon(this.db);
      this.rowCache = new RowCache(this.db,{key:'sku',initial:() => ({latest:null,price:null,seller:null,
        prices:{listed:emptySummary(),regular:emptySummary(),ozon_card:emptySummary()},sparkline:[]}),
      reduce:(state,row) => {
        state.latest = row;
        if (row.status === 'ok') {
          state.price = row;
          if (row.seller_id != null) state.seller = row;
          for (const [type,column] of [['listed','listed_price_kopecks'],['regular','regular_kopecks'],['ozon_card','ozon_card_kopecks']]) {
            if (row[column] != null) recordPrice(state.prices[type],row[column],row.checked_at,
              {change:!['out_of_stock','unavailable'].includes(row.availability)});
          }
        }
        const {checked_at,status,availability,listed_price_kopecks,regular_kopecks,ozon_card_kopecks,seller_id,message} = row;
        appendSparkline(state,{checked_at,status,availability,listed_price_kopecks,regular_kopecks,ozon_card_kopecks,seller_id,message});
      }});
      this.historyCache = new HistoryCache(this.db,{scopes:lists,
        sources:[{table:'observations',event:row => `'c:'||${row}.check_id`},
          {table:'list_snapshots',event:row => `'c:'||${row}.check_id`},{table:'checks',event:row => `'c:'||${row}.id`}]});
      this.published = new CollectionSnapshot(this.db,{scopes:lists,build:list => this.dashboard(list),sellers:true});
    } catch (error) {this.db.close(); throw error;}
  }
  close() {this.db.close();}
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = action(); this.db.exec('COMMIT'); return result;} catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  bindContext(digest, {legacyDigest} = {}) {
    const previous = this.db.prepare('SELECT context_digest FROM ozon_meta WHERE id=1').get().context_digest;
    if (previous && previous !== digest && previous !== legacyDigest) throw new ValidationError('Аккаунт Ozon изменился. Требуется отдельная история для нового подключения.');
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
        if (items === undefined) continue;
        this.replaceList(list,items,now);
      }
    });
  }
  replaceList(list, items, now) {
    this.db.prepare('DELETE FROM membership WHERE list=?').run(list);
    for (const [position, product] of items.entries()) {
      this.upsert(product,now);
      this.db.prepare('INSERT INTO membership(sku,list,quantity,position) VALUES(?,?,?,?)').run(product.external_id,list,product.quantity || 1,position);
    }
  }
  withSavedPrice(product) {
    if (!['out_of_stock','unavailable'].includes(product.availability)) return product;
    const previous = this.db.prepare("SELECT availability FROM observations WHERE sku=? AND status='ok' ORDER BY id DESC LIMIT 1").get(product.external_id);
    const becameUnavailable = previous && !['out_of_stock','unavailable'].includes(previous.availability);
    const saved = this.db.prepare(`SELECT * FROM observations WHERE sku=? AND status='ok'
      AND (listed_price_kopecks IS NOT NULL OR regular_kopecks IS NOT NULL OR ozon_card_kopecks IS NOT NULL)
      AND (?=0 OR availability NOT IN ('out_of_stock','unavailable'))
      ORDER BY id DESC LIMIT 1`).get(product.external_id,Number(!!becameUnavailable));
    return {...product,listed_price_kopecks:saved?.listed_price_kopecks ?? null,
      original_price_kopecks:saved?.original_price_kopecks ?? null,
      regular_kopecks:saved?.regular_kopecks ?? null,ozon_card_kopecks:saved?.ozon_card_kopecks ?? null,
      seller_id:saved?.seller_id ?? null,seller_name:saved?.seller_name ?? null,
      price_at:saved?.checked_at ?? null,price_retained:!!saved,price_source:saved?.source ?? product.price_source};
  }
  recordFavorites(check, favorites, now, source = 'http') {
    if (!['http','browser'].includes(source) || !Array.isArray(favorites)) throw invalid();
    this.transaction(() => {
      this.replaceList('favorites',favorites,now);
      this.snapshotLists(check,'favorites');
      const insert = this.db.prepare(`INSERT INTO observations(check_id,sku,checked_at,status,availability,
        listed_price_kopecks,original_price_kopecks,regular_kopecks,ozon_card_kopecks,seller_id,seller_name,message,source)
        VALUES(?,?,?,'ok',?,?,?,?,?,?,?,?,?)`);
      for (const product of favorites) {
        const current = this.withSavedPrice(product);
        const price = current.listed_price_kopecks ?? null, original = current.original_price_kopecks ?? null;
        const priceSource = current.price_source ?? source;
        if (!['http','browser'].includes(priceSource)) throw invalid();
        if ([price,original].some(value => value !== null && (!Number.isSafeInteger(value) || value <= 0))) throw invalid();
        const unavailable = ['out_of_stock','unavailable'].includes(product.availability);
        if (unavailable) {
          const latest = this.db.prepare('SELECT * FROM observations WHERE sku=? ORDER BY id DESC LIMIT 1').get(product.external_id);
          // Unchanged unavailable items do not receive another price observation.
          if (latest?.status === 'ok' && latest.availability === product.availability
            && latest.listed_price_kopecks === price && latest.original_price_kopecks === original
            && latest.regular_kopecks === (current.regular_kopecks ?? null)
            && latest.ozon_card_kopecks === (current.ozon_card_kopecks ?? null)) continue;
        }
        const stamp = current.price_retained ? current.price_at : now;
        const message = unavailable ? current.price_retained
          ? `Товар недоступен; сохранена цена от ${stamp}. Статус получен ${now}; цена не запрашивалась.`
          : 'Товар недоступен; сохранённой цены нет, цена не запрашивалась.' : '';
        insert.run(check,product.external_id,stamp,product.availability,price,original,
          current.regular_kopecks ?? null,current.ozon_card_kopecks ?? null,current.seller_id ?? null,current.seller_name ?? null,message,priceSource);
      }
      this.db.prepare('UPDATE checks SET total=?,completed=? WHERE id=?').run(favorites.length,favorites.length,check);
    });
  }
  targets(list = null) {
    return this.db.prepare('SELECT DISTINCT p.* FROM products p JOIN membership m ON m.sku=p.sku WHERE (? IS NULL OR m.list=?) ORDER BY p.created_at,p.sku LIMIT 101').all(list,list);
  }
  snapshotLists(check, list = null) {
    this.db.prepare('INSERT INTO list_snapshots(check_id,list,sku,quantity) SELECT ?,list,sku,quantity FROM membership WHERE (? IS NULL OR list=?)').run(check,list,list);
  }
  state() {return this.db.prepare('SELECT * FROM collector_state WHERE id=1').get();}
  updateState({schedule_enabled,next_check,not_before,action_required,message,schedule_mode,schedule,interval_minutes,schedule_anchor}) {
    const fields = {schedule_enabled,next_check,not_before,action_required,message,schedule_mode,schedule,interval_minutes,schedule_anchor};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) this.db.prepare(`UPDATE collector_state SET ${key}=? WHERE id=1`).run(value);
  }
  checks() {return this.db.prepare('SELECT * FROM checks ORDER BY id DESC LIMIT 10').all();}
  recover(now) {
    const count = this.db.prepare("UPDATE checks SET status='interrupted',finished_at=?,message='Проверка прервана. Требуется проверить подключение.' WHERE status='running'").run(now).changes;
    if (count) this.updateState({action_required:1,message:'Предыдущая проверка Ozon прервана.'});
  }
  begin(trigger, now) {return this.published.start(() => Number(this.db.prepare("INSERT INTO checks(trigger,status,started_at) VALUES(?,'running',?)").run(trigger,now).lastInsertRowid));}
  progress(check, total) {this.db.prepare('UPDATE checks SET total=? WHERE id=?').run(total,check);}
  finish(check, status, message, now) {
    this.db.prepare('UPDATE checks SET status=?,message=?,finished_at=? WHERE id=?').run(status,message,now,check);
    if (status !== 'running') this.historyCache.refreshAll((list,events) => this.buildListHistory(list,events));
  }
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
  failure(check, sku, message, now, source = 'http') {
    if (!['http','browser'].includes(source)) throw invalid();
    this.transaction(() => {
      const saved = this.db.prepare("INSERT OR IGNORE INTO observations(check_id,sku,checked_at,status,message,source) VALUES(?,?,?,'error',?,?)").run(check,sku,now,message,source);
      if (saved.changes) this.db.prepare('UPDATE checks SET completed=completed+1 WHERE id=?').run(check);
    });
  }
  priceSummary(sku) {
    return Object.fromEntries(Object.entries(this.rowCache.read([sku]).get(String(sku)).prices).map(([type,summary]) => [type,publicSummary(summary)]));
  }
  row(product, state = null, membership = null, event = undefined) {
    const {latest,price,seller,prices,sparkline} = state || this.rowCache.read([product.sku]).get(String(product.sku));
    if (event === undefined) event = this.db.prepare('SELECT checked_at,old_name,new_name FROM seller_events WHERE sku=? ORDER BY id DESC LIMIT 1').get(product.sku);
    return {...product,id:itemId(product.sku),status:latest?.status || 'pending',checked_at:latest?.checked_at || null,
      price_at:price?.checked_at || null,listed_price_kopecks:price?.listed_price_kopecks ?? null,original_price_kopecks:price?.original_price_kopecks ?? null,
      regular_kopecks:price?.regular_kopecks ?? null,ozon_card_kopecks:price?.ozon_card_kopecks ?? null,
      availability:price?.availability || 'unknown',seller_id:seller?.seller_id || null,seller_name:seller?.seller_name || null,
      seller_change:event || null,message:latest?.message || '',lists:membership || this.db.prepare('SELECT list,quantity FROM membership WHERE sku=?').all(product.sku),
      price_summary:Object.fromEntries(Object.entries(prices).map(([type,summary]) => [type,publicSummary(summary)])),sparkline};
  }
  dashboard(list = 'favorites') {
    if (!lists.includes(list)) throw new ValidationError('Неизвестный список Ozon.');
    const products = this.db.prepare('SELECT p.* FROM products p JOIN membership m ON m.sku=p.sku WHERE m.list=? ORDER BY m.position,p.created_at DESC').all(list);
    const states = this.rowCache.read(products.map(product => product.sku)),memberships = new Map(),events = new Map();
    const selected = JSON.stringify(products.map(product => product.sku));
    for (const {sku,list,quantity} of this.db.prepare('SELECT sku,list,quantity FROM membership WHERE sku IN (SELECT value FROM json_each(?)) ORDER BY sku,list').all(selected)) {
      if (!memberships.has(sku)) memberships.set(sku,[]);memberships.get(sku).push({list,quantity});
    }
    for (const {sku,checked_at,old_name,new_name} of this.db.prepare(`SELECT sku,checked_at,old_name,new_name FROM seller_events e
      WHERE sku IN (SELECT value FROM json_each(?)) AND id=(SELECT MAX(id) FROM seller_events WHERE sku=e.sku)`).all(selected)) events.set(sku,{checked_at,old_name,new_name});
    const items = products.map(product => this.row(product,states.get(product.sku),memberships.get(product.sku) || [],events.get(product.sku) || null));
    const counts = Object.fromEntries(lists.map(name => [name,Number(this.db.prepare('SELECT COUNT(*) AS n FROM membership WHERE list=?').get(name).n)]));
    return {items,counts,list,history:this.listHistory(list)};
  }
  listHistory(list, days = 30, now = Date.now()) {
    if (!lists.includes(list)) throw new ValidationError('Неизвестный список Ozon.');
    const since = days ? new Date(now-days*86400000).toISOString() : '';
    return this.historyCache.read(list,since,events => this.buildListHistory(list,events));
  }
  buildListHistory(list, events = null) {
    const rows = this.db.prepare(`SELECT s.check_id,s.sku,s.quantity,c.finished_at,o.checked_at,o.status,o.availability,
      o.listed_price_kopecks,o.regular_kopecks,o.ozon_card_kopecks,o.seller_id,o.message
      FROM list_snapshots s JOIN checks c ON c.id=s.check_id
      LEFT JOIN observations o ON o.check_id=s.check_id AND o.sku=s.sku
      WHERE s.list=? AND c.status<>'running' AND c.finished_at IS NOT NULL
      ${events === null ? '' : 'AND s.check_id IN (SELECT substr(value,3) FROM json_each(?))'} ORDER BY c.finished_at,c.id,s.sku`)
      .all(list,...(events === null ? [] : [JSON.stringify(events)]));
    const runs = new Map();
    for (const row of rows) {
      if (!runs.has(row.check_id)) runs.set(row.check_id,[]);
      runs.get(row.check_id).push(row);
    }
    return [...runs.values()].filter(members => members.some(row => row.checked_at)).map(members => {
      const failed = members.filter(row => row.status === 'error');
      const point = {checked_at:members[0].finished_at,count:members.length,observed_count:members.filter(row => row.checked_at).length,
        message:[...new Set(failed.map(row => row.message).filter(Boolean))].join('; ')};
      for (const price of ['listed','regular','ozon_card']) {
        const column = price === 'listed' ? 'listed_price_kopecks' : price+'_kopecks';
        const known = members.filter(row => row.status === 'ok' && row[column] != null
          && (price === 'listed' ? !['out_of_stock','unavailable'].includes(row.availability) : row.availability === 'available'));
        const complete = known.length === members.length;
        point[price] = {known_total:known.reduce((sum,row) => sum+row[column]*row.quantity,0),priced_count:known.length,complete,
          status:failed.length ? 'error' : complete ? 'ok' : 'missing',
          composition:compositionKey([members.map(row => [row.sku,row.quantity]),known.map(row => [row.sku,row.seller_id])])};
      }
      return {key:'c:'+members[0].check_id,stamp:point.checked_at,position:members[0].check_id,point};
    });
  }
  publishedDashboard(list = 'favorites') {
    if (!lists.includes(list)) throw invalid();
    return this.published.dashboard(list);
  }
  publishedDetail(id,days) {return this.published.detail(id,boundary => this.detail(id,days,Date.now(),boundary));}
  detail(id, days = 30, now = Date.now(), {maxId,maxSellerId,product:savedProduct} = {}) {
    const sku = itemSku(id), product = this.product(sku);
    if (!product || ![0,7,30,90,365].includes(days)) throw new ValidationError('Товар или период Ozon не найден.');
    const since = days ? new Date(now-days*86400000).toISOString() : '';
    const points = this.db.prepare('SELECT checked_at,status,availability,listed_price_kopecks,original_price_kopecks,regular_kopecks,ozon_card_kopecks,seller_id,seller_name,message,source FROM observations WHERE sku=? AND checked_at>=?'+(maxId === undefined ? '' : ' AND id<=?')+' ORDER BY id DESC LIMIT 2000').all(sku,since,...(maxId === undefined ? [] : [maxId])).reverse();
    const seller_events = this.db.prepare('SELECT checked_at,old_name,new_name FROM seller_events WHERE sku=? AND checked_at>=?'+(maxSellerId === undefined ? '' : ' AND id<=?')+' ORDER BY id DESC LIMIT 2000').all(sku,since,...(maxSellerId === undefined ? [] : [maxSellerId])).reverse();
    return {product:savedProduct || this.row(product),points,seller_events};
  }
}
