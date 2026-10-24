import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import {mkdirSync, renameSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {now, moscowDate} from './time.js';
import {ValidationError} from './errors.js';

export const LISTS = Object.freeze({favorites: 'Избранное', cart: 'Корзина', 'my-cart': 'Моя корзина', watching: 'Наблюдение'});
export const CONTEXTS = Object.freeze({public: 'Цена на сайте', cart: 'Цена в корзине'});
const own = (object, key) => Object.hasOwn(object, key);

export class Database {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.connection = new DatabaseSync(path, {timeout: 30000});
    this.statements = new Map();
    this.connection.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS products(
        id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,brand TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',image TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS variants(
        id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),
        volume_ml TEXT NOT NULL DEFAULT '1.5',sku TEXT,label TEXT NOT NULL DEFAULT '1,5 мл',UNIQUE(product_id,sku));
      CREATE TABLE IF NOT EXISTS lists(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(
        id INTEGER PRIMARY KEY,list_id TEXT NOT NULL REFERENCES lists(id),variant_id INTEGER NOT NULL REFERENCES variants(id),
        joined_at TEXT NOT NULL,left_at TEXT,quantity INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX IF NOT EXISTS active_membership ON memberships(list_id,variant_id) WHERE left_at IS NULL;
      CREATE TABLE IF NOT EXISTS checks(
        id INTEGER PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',message TEXT NOT NULL DEFAULT '',completed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS observations(
        id INTEGER PRIMARY KEY,variant_id INTEGER NOT NULL REFERENCES variants(id),check_id INTEGER REFERENCES checks(id),
        checked_at TEXT NOT NULL,context TEXT NOT NULL,price INTEGER,original_price INTEGER,in_stock INTEGER,status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS observation_lookup ON observations(variant_id,context,checked_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    const schema = this.get("SELECT sql FROM sqlite_master WHERE name='variants'").sql;
    if (/UNIQUE\s*\(\s*product_id\s*,\s*volume_ml\s*\)/i.test(schema)) {
      this.connection.exec(`PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE variants_new(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),
          volume_ml TEXT NOT NULL DEFAULT '1.5',sku TEXT,label TEXT NOT NULL DEFAULT '1,5 мл',UNIQUE(product_id,sku));
        INSERT INTO variants_new SELECT * FROM variants;
        DROP TABLE variants;
        ALTER TABLE variants_new RENAME TO variants;
        COMMIT;
        PRAGMA foreign_keys=ON;`);
      this.statements.clear();
    }
    const observationSchema = this.get("SELECT sql FROM sqlite_master WHERE name='observations'").sql;
    if (/UNIQUE\s*\(\s*variant_id\s*,\s*checked_at\s*,\s*context\s*\)/i.test(observationSchema)) {
      // Independent checks can finish in the same second. Preserve every event and its original ID.
      this.transaction(() => this.connection.exec(`CREATE TABLE observations_new(
          id INTEGER PRIMARY KEY,variant_id INTEGER NOT NULL REFERENCES variants(id),check_id INTEGER REFERENCES checks(id),
          checked_at TEXT NOT NULL,context TEXT NOT NULL,price INTEGER,original_price INTEGER,in_stock INTEGER,status TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '');
        INSERT INTO observations_new(id,variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source)
          SELECT id,variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source FROM observations;
        DROP TABLE observations;
        ALTER TABLE observations_new RENAME TO observations;
        CREATE INDEX observation_lookup ON observations(variant_id,context,checked_at DESC,id DESC);`));
      this.statements.clear();
    }
    // Create after legacy table migrations, which replace observations and its indexes.
    this.connection.exec('CREATE INDEX IF NOT EXISTS observation_history ON observations(context,check_id,checked_at,id)');
    this.transaction(() => {
      for (const [key, label] of Object.entries(LISTS)) this.run('INSERT OR IGNORE INTO lists VALUES(?,?)', key, label);
      this.run("UPDATE checks SET status='interrupted',finished_at=?,message='Приложение было закрыто во время проверки' WHERE status='running'", now());
      for (const [key, value] of Object.entries({schedule: ['00:30', '09:00', '14:00', '20:00'], schedule_enabled: true})) {
        this.run('INSERT OR IGNORE INTO settings VALUES(?,?)', key, JSON.stringify(value));
      }
    });
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
  startCheck(trigger, timestamp = now()) {return Number(this.run('INSERT INTO checks(started_at,trigger) VALUES(?,?)', timestamp, trigger).lastInsertRowid);}
  updateCheck(id, fields) {
    const allowed = new Set(['status', 'message', 'completed', 'total', 'finished_at']);
    if (!Object.keys(fields).length || Object.keys(fields).some(key => !allowed.has(key))) throw new ValidationError('Invalid check update');
    this.run('UPDATE checks SET ' + Object.keys(fields).map(key => key + '=?').join(',') + ' WHERE id=?', ...Object.values(fields), id);
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
    return this.all(`SELECT v.id,v.sku,v.label,p.brand,p.name,p.url,p.image,m.quantity,m.joined_at FROM memberships m
      JOIN variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id
      WHERE m.list_id=? AND m.left_at IS NULL ORDER BY p.brand,p.name`, listId).map(row => {
      const latest = this.get('SELECT * FROM observations WHERE variant_id=? AND context=? ORDER BY checked_at DESC,id DESC LIMIT 1', row.id, context);
      const successful = this.all("SELECT * FROM observations WHERE variant_id=? AND context=? AND status='ok' AND price IS NOT NULL ORDER BY checked_at DESC,id DESC LIMIT 2", row.id, context);
      const last = successful[0];
      const stats = this.get("SELECT COUNT(*) AS observations,MIN(price) AS minimum FROM observations WHERE variant_id=? AND context=? AND status='ok'", row.id, context);
      const price = last && latest?.status !== 'missing' ? last.price : null;
      const previous = successful[1]?.price ?? null;
      return {...row, status: latest?.status || 'pending', price, previous_price: previous,
        in_stock: latest && latest.status !== 'error' ? Boolean(latest.in_stock) : last ? Boolean(last.in_stock) : null,
        checked_at: latest?.checked_at ?? null, price_at: last?.checked_at ?? null, message: latest?.message || '', ...stats,
        watching: Boolean(this.get("SELECT 1 FROM memberships WHERE variant_id=? AND list_id='watching' AND left_at IS NULL", row.id)),
        in_my_cart: Boolean(this.get("SELECT 1 FROM memberships WHERE variant_id=? AND list_id='my-cart' AND left_at IS NULL", row.id)),
        delta: latest?.status === 'ok' && price != null && previous != null ? price - previous : null,
        last_change: this.lastPriceChange(row.id, context, last),
        sparkline: this.all('SELECT checked_at,price,status FROM observations WHERE variant_id=? AND context=? ORDER BY checked_at DESC,id DESC LIMIT 24', row.id, context).reverse()};
    });
  }

  detail(id, context = 'public', days = 30) {
    this.validate('cart', context);
    const product = this.get('SELECT v.id,v.sku,v.label,p.brand,p.name,p.url FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?', id);
    if (!product) throw new ValidationError('Товар не найден');
    const since = days ? now(new Date(Date.now() - days * 86400000)) : '';
    return {product, context, points: this.all('SELECT checked_at,price,in_stock,status,message,source FROM observations WHERE variant_id=? AND context=? AND checked_at>=? ORDER BY checked_at,id', id, context, since)};
  }

  listHistory(listId, context = 'public', days = 30) {
    this.validate(listId, context);
    const since = days ? now(new Date(Date.now() - days * 86400000)) : '';
    const runs = this.all(`SELECT o.check_id,MAX(o.checked_at) AS checked_at,MIN(o.id) AS first_id FROM observations o JOIN memberships m ON m.variant_id=o.variant_id
      WHERE m.list_id=? AND o.context=? AND o.checked_at>=? AND o.checked_at>=m.joined_at AND (m.left_at IS NULL OR o.checked_at<m.left_at)
      GROUP BY o.check_id,CASE WHEN o.check_id IS NULL THEN o.checked_at END ORDER BY checked_at,first_id`, listId, context, since);
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
      return {checked_at: stamp, price: complete ? total : null, known_total: total, count: members.length,
        priced_count: known.length, complete, status: failed.length ? 'error' : complete ? 'ok' : 'missing',
        message: [...new Set(failed.map(row => row.message).filter(Boolean))].join('; '),
        composition: JSON.stringify([members, known.map(row => row.variant_id).sort((a, b) => a - b)])};
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
