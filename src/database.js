import {migrateRandewoo} from './storage-schema.js';
import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import {mkdirSync, renameSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {now, moscowDate} from './time.js';
import {ValidationError} from './errors.js';
import {HistoryCache,RowCache,compositionKey,emptySummary,recordPrice,appendSparkline} from './dashboard-cache.js';
import {CollectionSnapshot} from './collection-snapshot.js';

export const LISTS = Object.freeze({favorites: 'Избранное', cart: 'Корзина', 'my-cart': 'Моя корзина', watching: 'Наблюдение'});
export const CONTEXTS = Object.freeze({public: 'Цена на сайте', cart: 'Цена в корзине'});
const own = (object, key) => Object.hasOwn(object, key);

export class Database {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.connection = new DatabaseSync(path, {timeout: 30000});
    this.statements = new Map();
    try {
      migrateRandewoo(this.connection);
      this.transaction(() => {
        for (const [key, label] of Object.entries(LISTS)) this.run('INSERT OR IGNORE INTO lists VALUES(?,?)', key, label);
        this.run("UPDATE checks SET status='interrupted',finished_at=?,message='Приложение было закрыто во время проверки' WHERE status='running'", now());
        for (const [key, value] of Object.entries({schedule: ['00:30', '09:00', '14:00', '20:00'], schedule_enabled: true})) {
          this.run('INSERT OR IGNORE INTO settings VALUES(?,?)', key, JSON.stringify(value));
        }
      });
      this.rowCache = new RowCache(this.connection,{key:'variant_id',scope:'context',chronological:true,
        initial:() => ({latest:null,last:null,previous:null,summary:emptySummary(),sparkline:[]}),
        reduce:(state,row) => {
          state.latest = row;
          if (row.status === 'ok') {
            recordPrice(state.summary,row.price,row.checked_at);
            if (row.price != null) {state.previous = state.last?.price ?? null;state.last = row;}
          }
          appendSparkline(state,{checked_at:row.checked_at,price:row.price,status:row.status});
        }});
      this.historyCache = new HistoryCache(this.connection,{
        scopes:Object.keys(LISTS).flatMap(list => Object.keys(CONTEXTS).map(context => list+':'+context)),
        sources:[{table:'observations',event:row => `CASE WHEN ${row}.check_id IS NULL THEN 't:'||${row}.checked_at ELSE 'c:'||${row}.check_id END`},
          {table:'checks',event:row => `'c:'||${row}.id`}],
        resets:[{table:'memberships',scope:row => `scope LIKE ${row}.list_id||':%'`,
          changed:'OLD.list_id IS NOT NEW.list_id OR OLD.variant_id IS NOT NEW.variant_id OR OLD.joined_at IS NOT NEW.joined_at OR OLD.left_at IS NOT NEW.left_at'}],
      });
      this.published = new CollectionSnapshot(this.connection,{
        scopes:Object.keys(LISTS).flatMap(list => Object.keys(CONTEXTS).map(context => list+':'+context)),
        build:scope => {const [list,context] = scope.split(':');return this.dashboard(list,context);},
      });
    } catch (error) {this.connection.close();throw error;}
  }

  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.connection.prepare(sql));
    return this.statements.get(sql);
  }
  run(sql, ...args) {return this.statement(sql).run(...args.map(value => typeof value === 'boolean' ? Number(value) : value ?? null));}
  get(sql, ...args) {const row = this.statement(sql).get(...args); return row ? {...row} : null;}
  all(sql, ...args) {return this.statement(sql).all(...args).map(row => ({...row}));}
  transaction(action) {
    this.connection.exec('BEGIN IMMEDIATE');
    try {const result = action(); this.connection.exec('COMMIT'); return result;}
    catch (error) {this.connection.exec('ROLLBACK'); throw error;}
  }
  close() {this.statements.clear(); this.connection.close();}

  setting(key, fallback = null) {const row = this.get('SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) : fallback;}
  setSetting(key, value) {this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));}

  variant(item) {
    return this.transaction(() => {
      this.run(`INSERT INTO products(url,brand,name,image) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET
        brand=CASE WHEN excluded.brand!='' THEN excluded.brand ELSE products.brand END,
        name=CASE WHEN excluded.name!='' THEN excluded.name ELSE products.name END,
        image=CASE WHEN excluded.image!='' THEN excluded.image ELSE products.image END`, item.url, item.brand || '', item.name || '', item.image || '');
      const productId = this.get('SELECT id FROM products WHERE url=?', item.url).id;
      const sku = item.sku == null ? null : String(item.sku);
      let row = this.get('SELECT id FROM variants WHERE product_id=? AND sku IS ?', productId, sku);
      if (!row && sku) row = this.get('SELECT id FROM variants WHERE product_id=? AND sku IS NULL LIMIT 1', productId);
      if (row) {
        if (sku) this.run('UPDATE variants SET sku=?,label=? WHERE id=?', sku, item.variant || '1,5 мл', row.id);
        return row.id;
      }
      if (!sku) {row = this.get('SELECT id FROM variants WHERE product_id=? ORDER BY id LIMIT 1', productId); if (row) return row.id;}
      return Number(this.run('INSERT INTO variants(product_id,sku,label) VALUES(?,?,?)', productId, sku, item.variant || '1,5 мл').lastInsertRowid);
    });
  }

  productVariants(url) {return this.all('SELECT v.* FROM variants v JOIN products p ON p.id=v.product_id WHERE p.url=?', url);}
  addMembers(listId, variantIds) {
    this.transaction(() => {for (const id of variantIds) this.run('INSERT OR IGNORE INTO memberships(list_id,variant_id,joined_at) VALUES(?,?,?)', listId, id, now());});
  }
  syncList(listId, entries, timestamp = now()) {
    const expected = new Map(entries);
    this.transaction(() => {
      const existing = new Map(this.all('SELECT * FROM memberships WHERE list_id=? AND left_at IS NULL', listId).map(row => [row.variant_id, row]));
      for (const [id, member] of existing) if (!expected.has(id)) this.run('UPDATE memberships SET left_at=? WHERE id=?', timestamp, member.id);
      for (const [id, quantity] of expected) {
        if (existing.has(id)) this.run('UPDATE memberships SET quantity=? WHERE id=?', quantity, existing.get(id).id);
        else this.run('INSERT INTO memberships(list_id,variant_id,joined_at,quantity) VALUES(?,?,?,?)', listId, id, timestamp, quantity);
      }
    });
  }
  localMember(listId, id, active = true) {
    if (!['watching', 'my-cart'].includes(listId)) throw new ValidationError('Этот список обновляется с Randewoo');
    if (!this.get('SELECT id FROM variants WHERE id=?', id)) throw new ValidationError('Товар не найден');
    if (active) this.run('INSERT OR IGNORE INTO memberships(list_id,variant_id,joined_at) VALUES(?,?,?)', listId, id, now());
    else this.run('UPDATE memberships SET left_at=? WHERE list_id=? AND variant_id=? AND left_at IS NULL', now(), listId, id);
  }
  watch(id, active = true) {this.localMember('watching', id, active);}
  personalCart(id, active = true) {this.localMember('my-cart', id, active);}
  activeVariants() {
    return this.all(`SELECT DISTINCT v.id,v.sku,p.url,p.brand,p.name,p.image,v.label FROM variants v JOIN products p ON p.id=v.product_id
      JOIN memberships m ON m.variant_id=v.id WHERE m.left_at IS NULL`);
  }
  observation(id, item, context, checkId = null, timestamp = now(), source = 'Randewoo') {
    const status = item.status || 'ok';
    this.run(`INSERT INTO observations(variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, id, checkId, timestamp, context, status === 'ok' ? item.price_kopecks : null,
      item.original_price_kopecks, status === 'error' ? null : item.in_stock, status, item.message || '', source);
  }
  startCheck(trigger, timestamp = now()) {return this.published.start(() => Number(this.run('INSERT INTO checks(started_at,trigger) VALUES(?,?)', timestamp, trigger).lastInsertRowid));}
  updateCheck(id, fields) {
    const allowed = new Set(['status', 'message', 'completed', 'total', 'finished_at']);
    if (!Object.keys(fields).length || Object.keys(fields).some(key => !allowed.has(key))) throw new ValidationError('Invalid check update');
    this.run('UPDATE checks SET ' + Object.keys(fields).map(key => key + '=?').join(',') + ' WHERE id=?', ...Object.values(fields), id);
    if (fields.status && fields.status !== 'running') this.historyCache.refreshAll((scope,events) => this.buildListHistory(...scope.split(':'),events));
  }
  checks(limit = 12) {return this.all('SELECT * FROM checks ORDER BY id DESC LIMIT ?', limit);}
  counts() {return Object.fromEntries(Object.keys(LISTS).map(key => [key, this.get('SELECT COUNT(*) AS n FROM memberships WHERE list_id=? AND left_at IS NULL', key).n]));}

  validate(listId, context) {
    if (!own(LISTS, listId) || !own(CONTEXTS, context)) throw new ValidationError('Неизвестный список или тип цены');
  }
  lastPriceChange(variantId, context, last) {
    if (!last) return null;
    const previous = this.get(`SELECT id,checked_at,price FROM observations
      WHERE variant_id=? AND context=? AND status='ok' AND price IS NOT NULL AND price!=?
      ORDER BY checked_at DESC,id DESC LIMIT 1`, variantId, context, last.price);
    if (!previous) return null;
    // Find the first reading at the current price after the last different price.
    // Equal readings, errors and missing variants must not move the detection time.
    const change = this.get(`SELECT checked_at,price FROM observations
      WHERE variant_id=? AND context=? AND status='ok' AND price=?
      AND (checked_at>? OR (checked_at=? AND id>?)) ORDER BY checked_at,id LIMIT 1`,
    variantId, context, last.price, previous.checked_at, previous.checked_at, previous.id);
    return {checked_at: change.checked_at, previous_price: previous.price, price: change.price, delta: change.price - previous.price};
  }
  rows(listId, context = 'public') {
    this.validate(listId, context);
    const products = this.all(`SELECT v.id,v.sku,v.label,p.brand,p.name,p.url,p.image,m.quantity,m.joined_at,
      w.id IS NOT NULL AS watching,pc.id IS NOT NULL AS in_my_cart FROM memberships m
      JOIN variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id
      LEFT JOIN memberships w ON w.variant_id=v.id AND w.list_id='watching' AND w.left_at IS NULL
      LEFT JOIN memberships pc ON pc.variant_id=v.id AND pc.list_id='my-cart' AND pc.left_at IS NULL
      WHERE m.list_id=? AND m.left_at IS NULL ORDER BY p.brand,p.name`, listId);
    const summaries = this.rowCache.read(products.map(row => row.id),context);
    return products.map(row => {
      const {latest,last,previous,summary,sparkline} = summaries.get(String(row.id));
      const price = last && latest?.status !== 'missing' ? last.price : null;
      return {...row, status: latest?.status || 'pending', price, previous_price: previous,
        in_stock: latest && latest.status !== 'error' ? Boolean(latest.in_stock) : last ? Boolean(last.in_stock) : null,
        checked_at: latest?.checked_at ?? null, price_at: last?.checked_at ?? null, message: latest?.message || '',
        observations:summary.observations,minimum:summary.minimum,
        watching:Boolean(row.watching),in_my_cart:Boolean(row.in_my_cart),
        delta: latest?.status === 'ok' && price != null && previous != null ? price - previous : null,
        last_change:summary.last_change,sparkline};
    });
  }

  dashboard(list,context) {return {items:this.rows(list,context),counts:this.counts(),list,context,history:this.listHistory(list,context)};}
  publishedDashboard(list,context) {this.validate(list,context);return this.published.dashboard(list+':'+context);}
  publishedDetail(id,context,days) {return this.published.detail(id,boundary => this.detail(id,context,days,boundary));}
  detail(id, context = 'public', days = 30, {maxId,product:savedProduct} = {}) {
    this.validate('cart', context);
    const product = this.get('SELECT v.id,v.sku,v.label,p.brand,p.name,p.url FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?', id);
    if (!product) throw new ValidationError('Товар не найден');
    const since = days ? now(new Date(Date.now() - days * 86400000)) : '';
    const publishedProduct = savedProduct ? Object.fromEntries(Object.keys(product).map(key => [key,savedProduct[key]])) : product;
    return {product:publishedProduct, context, points: this.all('SELECT checked_at,price,in_stock,status,message,source FROM observations WHERE variant_id=? AND context=? AND checked_at>=?'+(maxId === undefined ? '' : ' AND id<=?')+' ORDER BY checked_at,id', id, context, since, ...(maxId === undefined ? [] : [maxId]))};
  }

  listHistory(listId, context = 'public', days = 30) {
    this.validate(listId, context);
    const since = days ? now(new Date(Date.now() - days * 86400000)) : '';
    return this.historyCache.read(listId+':'+context,since,events => this.buildListHistory(listId,context,events));
  }
  buildListHistory(listId, context, changed = null) {
    const runs = this.all(`SELECT o.check_id,MAX(o.checked_at) AS checked_at,MIN(o.id) AS first_id,
      CASE WHEN o.check_id IS NULL THEN 't:'||o.checked_at ELSE 'c:'||o.check_id END AS event
      FROM observations o JOIN memberships m ON m.variant_id=o.variant_id LEFT JOIN checks c ON c.id=o.check_id
      WHERE m.list_id=? AND o.context=? AND o.checked_at>=m.joined_at AND (m.left_at IS NULL OR o.checked_at<m.left_at)
      AND (o.check_id IS NULL OR c.status<>'running')
      ${changed === null ? '' : 'AND (o.check_id IN (SELECT substr(value,3) FROM json_each(?) WHERE value LIKE \'c:%\') OR (o.check_id IS NULL AND o.checked_at IN (SELECT substr(value,3) FROM json_each(?) WHERE value LIKE \'t:%\')))'}
      GROUP BY o.check_id,CASE WHEN o.check_id IS NULL THEN o.checked_at END ORDER BY checked_at,first_id`,
    listId,context,...(changed === null ? [] : [JSON.stringify(changed),JSON.stringify(changed)]));
    if (!runs.length) return [];
    const memberships = this.all(`SELECT id,variant_id,joined_at,left_at FROM memberships
      WHERE list_id=? AND joined_at<=? AND (left_at IS NULL OR left_at>?)`, listId, runs.at(-1).checked_at, runs[0].checked_at);
    const events = memberships.flatMap(member => [
      {stamp: member.joined_at, member, join: true},
      ...(member.left_at == null ? [] : [{stamp: member.left_at, member, join: false}]),
    ]).sort((a, b) => a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : Number(b.join) - Number(a.join));
    // JSON supplies a bounded table of selected runs without SQLite's parameter-count limit.
    // Include readings before `since` when their check finishes inside the selected period.
    // CROSS JOIN keeps the small run table outermost; materialize JSON extraction once per run.
    const observations = this.all(`WITH selected AS MATERIALIZED (
        SELECT key AS run_index,json_extract(value,'$.check_id') AS check_id,
          json_extract(value,'$.checked_at') AS checked_at FROM json_each(?))
      SELECT r.run_index,o.variant_id,o.checked_at,o.price,o.in_stock,o.status,o.message
      FROM selected r CROSS JOIN observations o
        ON o.context=? AND o.check_id IS r.check_id AND o.checked_at<=r.checked_at
        AND o.checked_at>=CASE WHEN r.check_id IS NULL THEN r.checked_at ELSE '' END
      ORDER BY r.run_index,o.checked_at,o.id`, JSON.stringify(runs), context);
    const active = new Map();
    let eventIndex = 0, observationIndex = 0;
    return runs.map((run, runIndex) => {
      const stamp = run.checked_at;
      while (eventIndex < events.length && events[eventIndex].stamp <= stamp) {
        const {member, join} = events[eventIndex++];
        if (join) active.set(member.id, member);
        else active.delete(member.id);
      }
      const members = [...active.values()].map(member => member.variant_id).sort((a, b) => a - b);
      const joined = new Map();
      for (const member of active.values()) {
        if (!joined.has(member.variant_id) || member.joined_at < joined.get(member.variant_id)) joined.set(member.variant_id, member.joined_at);
      }
      const latest = new Map();
      while (observationIndex < observations.length && observations[observationIndex].run_index === runIndex) {
        const row = observations[observationIndex++];
        if (joined.has(row.variant_id) && row.checked_at >= joined.get(row.variant_id)) latest.set(row.variant_id, row);
      }
      const rows = [...latest.values()];
      const known = rows.filter(row => row.status === 'ok' && row.price != null && row.in_stock);
      const failed = rows.filter(row => row.status === 'error');
      const complete = known.length === members.length && members.length > 0;
      const total = known.reduce((sum, row) => sum + row.price, 0);
      return {key:run.event,stamp,position:run.first_id,point:{checked_at: stamp, price: complete ? total : null, known_total: total, count: members.length,
        priced_count: known.length, complete, status: failed.length ? 'error' : complete ? 'ok' : 'missing',
        message: [...new Set(failed.map(row => row.message).filter(Boolean))].join('; '),
        composition: compositionKey([members, known.map(row => row.variant_id).sort((a, b) => a - b)])}};
    });
  }

  async backup(directory) {
    mkdirSync(directory, {recursive: true});
    const target = join(directory, 'prices-' + moscowDate() + '.sqlite3');
    const temporary = target + '.tmp';
    await sqliteBackup(this.connection, temporary);
    renameSync(temporary, target);
    return target;
  }
}
