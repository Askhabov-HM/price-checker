import {migrate,projectionVersion,storageContract} from './storage-migrations.js';
import {createHash} from 'node:crypto';

// The graph only compares compositions for equality. Keep the complete digest so
// quantity, availability and seller changes retain exactly the same boundaries.
export const compositionKey = value => 'c1:' + createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('base64url');

function atomic(sql, name, action) {
  sql.exec('SAVEPOINT ' + name);
  try {const result = action(); sql.exec('RELEASE ' + name); return result;}
  catch (error) {sql.exec('ROLLBACK TO ' + name); sql.exec('RELEASE ' + name); throw error;}
}

// Disposable, additive projections. Source-table triggers also cover imports,
// repairs, old application versions and writes from another process.
export class HistoryCache {
  constructor(sql, {name = 'list_history', scopes, sources, resets = [], order = 'stamp,position', version = storageContract.projections.history}) {
    this.sql = sql; this.name = name; this.order = order; this.version = version;
    const schema = [];
    schema.push(`CREATE TABLE IF NOT EXISTS ${name}_scopes(scope TEXT PRIMARY KEY,initialized INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ${name}_points(scope TEXT NOT NULL,event TEXT NOT NULL,stamp TEXT NOT NULL,
        position INTEGER NOT NULL,point TEXT NOT NULL,PRIMARY KEY(scope,event));
      CREATE INDEX IF NOT EXISTS ${name}_period ON ${name}_points(scope,stamp,position);
      CREATE TABLE IF NOT EXISTS ${name}_dirty(scope TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(scope,event));`);
    for (const {table,event} of sources) {
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        const aliases = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD','NEW'];
        schema.push(`CREATE TRIGGER IF NOT EXISTS ${name}_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
          ${aliases.map(row => `INSERT OR IGNORE INTO ${name}_dirty SELECT scope,${event(row)} FROM ${name}_scopes;`).join('\n')}
        END;`);
      }
    }
    for (const {table,scope,changed = '1'} of resets) {
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        const aliases = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD','NEW'];
        schema.push(`CREATE TRIGGER IF NOT EXISTS ${name}_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          ${operation === 'UPDATE' ? 'WHEN ' + changed : ''} BEGIN
          ${aliases.map(row => `INSERT OR IGNORE INTO ${name}_dirty SELECT scope,'*' FROM ${name}_scopes WHERE ${scope(row)};`).join('\n')}
        END;`);
      }
    }
    migrate(sql,{component:name+'_schema',definition:schema.join('\n'),apply:() => sql.exec(schema.join('\n'))});
    const add = sql.prepare(`INSERT OR IGNORE INTO ${name}_scopes(scope) VALUES(?)`);
    for (const scope of scopes) add.run(scope);
  }
  ensureVersion() {
    const {sql,name} = this;
    projectionVersion(sql,name,this.version,() => {
      sql.exec(`DELETE FROM ${name}_points; DELETE FROM ${name}_dirty; UPDATE ${name}_scopes SET initialized=0`);
    });
  }
  refresh(scope,build) {return atomic(this.sql,this.name+'_version',() => {this.ensureVersion();return this.refreshCurrent(scope,build);});}
  refreshCurrent(scope, build) {
    const {sql,name} = this;
    const dirty = () => sql.prepare(`SELECT event FROM ${name}_dirty WHERE scope=?`).all(scope).map(row => row.event);
    const initialized = () => sql.prepare(`SELECT initialized FROM ${name}_scopes WHERE scope=?`).get(scope)?.initialized;
    if (initialized() && !dirty().length) return;
    atomic(sql, name + '_refresh', () => {
      const events = dirty(), all = !initialized() || events.includes('*');
      const points = build(all ? null : events);
      if (all) sql.prepare(`DELETE FROM ${name}_points WHERE scope=?`).run(scope);
      else sql.prepare(`DELETE FROM ${name}_points WHERE scope=? AND event IN (SELECT value FROM json_each(?))`).run(scope,JSON.stringify(events));
      const insert = sql.prepare(`INSERT OR REPLACE INTO ${name}_points VALUES(?,?,?,?,?)`);
      for (const {key,stamp,position,point} of points) insert.run(scope,key,stamp,position,JSON.stringify(point));
      sql.prepare(`DELETE FROM ${name}_dirty WHERE scope=?`).run(scope);
      sql.prepare(`UPDATE ${name}_scopes SET initialized=1 WHERE scope=?`).run(scope);
    });
  }
  read(scope, since, build) {
    return atomic(this.sql,this.name+'_read',() => {
      this.refresh(scope,build);
      return this.sql.prepare(`SELECT point FROM ${this.name}_points WHERE scope=? AND stamp>=? ORDER BY ${this.order}`)
        .all(scope,since).map(row => JSON.parse(row.point));
    });
  }
  refreshAll(build) {
    for (const {scope} of this.sql.prepare(`SELECT scope FROM ${this.name}_scopes`).all()) this.refresh(scope,events => build(scope,events));
  }
}

export class RowCache {
  constructor(sql, {name = 'price_rows', table = 'observations', key, scope = "''", chronological = false, reverseTies = false, initial, reduce, version = storageContract.projections.rows}) {
    Object.assign(this,{sql,name,table,key,scope,chronological,reverseTies,initial,reduce,version});
    const schema = [];
    schema.push(`CREATE TABLE IF NOT EXISTS ${name}(scope TEXT NOT NULL,item TEXT NOT NULL,cursor INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(scope,item));
      CREATE TABLE IF NOT EXISTS ${name}_dirty(scope TEXT NOT NULL,item TEXT NOT NULL,reset INTEGER NOT NULL,PRIMARY KEY(scope,item));`);
    for (const operation of ['INSERT','UPDATE','DELETE']) {
      const aliases = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD','NEW'];
      schema.push(`CREATE TRIGGER IF NOT EXISTS ${name}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
        ${aliases.map(row => {
          const item = `CAST(${row}.${key} AS TEXT)`, context = scope === "''" ? scope : row + '.' + scope;
          const reset = operation === 'INSERT'
            ? `EXISTS(SELECT 1 FROM ${name} WHERE scope=${context} AND item=${item} AND cursor>=${row}.rowid)` : '1';
          return `INSERT INTO ${name}_dirty VALUES(${context},${item},${reset})
            ON CONFLICT(scope,item) DO UPDATE SET reset=MAX(reset,excluded.reset);`;
        }).join('\n')}
      END;`);
    }
    migrate(sql,{component:name+'_schema',definition:schema.join('\n'),apply:() => sql.exec(schema.join('\n'))});
  }
  read(keys,scope = '') {
    return atomic(this.sql,this.name+'_read',() => {
      projectionVersion(this.sql,this.name,this.version,() => this.sql.exec(`DELETE FROM ${this.name}; DELETE FROM ${this.name}_dirty`));
      return this.readCurrent(keys,scope);
    });
  }
  readCurrent(keys, scope = '') {
    if (!keys.length) return new Map();
    const {sql,name} = this, wanted = JSON.stringify(keys.map(String));
    const load = () => sql.prepare(`SELECT CAST(w.value AS TEXT) AS item,c.cursor,c.state,d.reset,d.item AS dirty
      FROM json_each(?) w LEFT JOIN ${name} c ON c.scope=? AND c.item=CAST(w.value AS TEXT)
      LEFT JOIN ${name}_dirty d ON d.scope=? AND d.item=CAST(w.value AS TEXT)`).all(wanted,scope,scope);
    let cached = load();
    if (cached.some(row => row.state == null || row.dirty != null)) {
      atomic(sql,name + '_refresh',() => {
        cached = load();
        const pending = cached.filter(row => row.state == null || row.dirty != null);
        const states = new Map(pending.map(row => [row.item,row.state == null || row.reset ? this.initial() : JSON.parse(row.state)]));
        const cursors = new Map(pending.map(row => [row.item,row.state == null || row.reset ? 0 : row.cursor]));
        const fetch = entries => sql.prepare(`WITH wanted AS MATERIALIZED (
          SELECT json_extract(value,'$.item') AS item,json_extract(value,'$.cursor') AS cursor FROM json_each(?))
          SELECT o.*,o.rowid AS cache_id FROM wanted w CROSS JOIN ${this.table} o
          ON o.${this.key}=w.item AND o.rowid>w.cursor
          ${this.scope === "''" ? '' : 'AND o.' + this.scope + '=?'} ORDER BY ${this.chronological ? 'o.checked_at,' : ''}o.rowid ${this.reverseTies ? 'DESC' : ''}`)
          .all(JSON.stringify(entries),...(this.scope === "''" ? [] : [scope]));
        let records = fetch(pending.map(row => ({item:row.item,cursor:cursors.get(row.item)})));
        // Imported readings may have an older timestamp or explicit row ID.
        // Rebuild only the affected products; normal appends fold new rows once.
        const restart = new Set();
        if (this.chronological) for (const row of records) {
          const state = states.get(String(row[this.key]));
          if (state.last_at && (row.checked_at < state.last_at || this.reverseTies && row.checked_at === state.last_at)) restart.add(String(row[this.key]));
        }
        if (restart.size) {
          for (const item of restart) {states.set(item,this.initial());cursors.set(item,0);}
          records = records.filter(row => !restart.has(String(row[this.key]))).concat(fetch([...restart].map(item => ({item,cursor:0}))));
        }
        for (const record of records) {
          const item = String(record[this.key]),state = states.get(item),{cache_id,...row} = record;
          this.reduce(state,row);state.last_at = row.checked_at;
          cursors.set(item,Math.max(cursors.get(item),cache_id));
        }
        const save = sql.prepare(`INSERT INTO ${name} VALUES(?,?,?,?) ON CONFLICT(scope,item) DO UPDATE SET cursor=excluded.cursor,state=excluded.state`);
        const clear = sql.prepare(`DELETE FROM ${name}_dirty WHERE scope=? AND item=?`);
        for (const row of pending) {
          row.state = JSON.stringify(states.get(row.item));
          save.run(scope,row.item,cursors.get(row.item),row.state);clear.run(scope,row.item);
        }
      });
    }
    return new Map(cached.map(row => [row.item,JSON.parse(row.state)]));
  }
}

export function recordPrice(summary, price, stamp, {count = true, change = true} = {}) {
  if (count) summary.observations++;
  if (price == null) return;
  summary.minimum = summary.minimum == null ? price : Math.min(summary.minimum,price);
  if (change && summary.previous != null && summary.previous !== price) {
    summary.last_change = {checked_at:stamp,previous_price:summary.previous,price,delta:price-summary.previous};
  }
  summary.previous = price;
}
export const emptySummary = () => ({minimum:null,observations:0,previous:null,last_change:null});
export const publicSummary = ({minimum,observations,last_change}) => ({minimum,observations,last_change});
export function appendSparkline(state, row) {state.sparkline.push(row);if (state.sparkline.length > 24) state.sparkline.shift();}
