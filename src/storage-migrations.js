import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const storageContract = JSON.parse(readFileSync(new URL('../storage-contract.json',import.meta.url),'utf8'));
export const publishedVersion = () => Object.values(storageContract.projections).every(version => version === 1)
  ? '1' : JSON.stringify(storageContract.projections);
let revision = 'workspace';
try {revision = readFileSync(new URL('../REVISION',import.meta.url),'utf8').trim();} catch {}
export class StorageError extends Error {
  constructor(code) {super(code);this.code = code;}
}
export function storageFailure(error) {
  return {ok:false,reason:error instanceof StorageError ? error.code : 'storage_operation_failed',
    ...(['randewoo','ozon','lamoda'].includes(error.store) ? {store:error.store} : {}),
    ...(typeof error.storageComponent === 'string' && /^[A-Za-z_]+$/.test(error.storageComponent) ? {component:error.storageComponent} : {})};
}
export const tableExists = (sql,name) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columns = (sql,name) => new Set(sql.prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name));

// Recognize legacy stores before journal_mode, schema changes or any other write.
export function assertStorage(sql,store,{legacy = true,contract = storageContract} = {}) {
  const supported = contract.stores[store];
  if (!supported) throw new StorageError('unknown_store');
  if (tableExists(sql,'storage_meta')) {
    const meta = sql.prepare('SELECT * FROM storage_meta WHERE id=1').get();
    if (meta?.store !== store || !supported.read.includes(meta.format) || !supported.write.includes(meta.format)) throw new StorageError('incompatible_storage_format');
  } else if (!legacy) throw new StorageError('unversioned_storage');
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (!tables.length) return;
  if (store !== 'randewoo') {
    const name = store+'_meta';
    if (!tableExists(sql,name)) throw new StorageError('foreign_storage');
    const meta = sql.prepare(`SELECT provider,version FROM ${name} WHERE id=1`).get();
    if (meta?.provider !== store+'-prices' || meta.version !== 1) throw new StorageError('foreign_storage');
  } else if (tableExists(sql,'ozon_meta') || tableExists(sql,'lamoda_meta')) throw new StorageError('foreign_storage');
  const expected = store === 'randewoo'
    ? {products:['id','url','brand','name','image'],variants:['id','product_id','sku','volume_ml','label'],
      checks:['id','started_at','finished_at','trigger','status','message','completed','total'],
      observations:['id','variant_id','check_id','checked_at','context','price','original_price','in_stock','status','message','source']}
    : store === 'ozon' ? {products:['sku','url','title','image_url','created_at'],
      checks:['id','trigger','status','started_at','finished_at','total','completed','message'],
      observations:['id','check_id','sku','checked_at','status','availability','regular_kopecks','ozon_card_kopecks','seller_id','seller_name','message'],
      collector_state:['id','schedule_enabled','next_check','not_before','action_required','message']}
      : {products:['sku','title','color','url','image_url','position','active'],
        checks:['id','event_id','trigger','status','started_at','finished_at','total','completed','message','down','up'],
        observations:['id','check_id','sku','checked_at','price_at','price','original_price','availability','status','message','source'],
        collector_state:['id','schedule_enabled','schedule_mode','schedule','interval_minutes','schedule_anchor','next_check','not_before','action_required','message']};
  if (tableExists(sql,'storage_meta') && store === 'ozon') {
    expected.observations.push('source','listed_price_kopecks','original_price_kopecks');
    expected.collector_state.push('schedule_mode','schedule','interval_minutes','schedule_anchor');
  }
  for (const [table,required] of Object.entries(expected)) {
    const present = columns(sql,table);
    if (!required.every(column => present.has(column))) throw new StorageError('unrecognized_storage_schema');
  }
}

export function atomicStorage(sql,name,action) {
  sql.exec('SAVEPOINT '+name);
  try {const result = action();sql.exec('RELEASE '+name);return result;}
  catch (error) {sql.exec('ROLLBACK TO '+name+'; RELEASE '+name);throw error;}
}

// Definitions are immutable once shipped. Append another numbered migration.
// The successful journal entry and its schema/data changes commit together.
export function migrate(sql,{component,version = 1,definition,apply,store,foreignKeysOff = false}) {
  if (store) assertStorage(sql,store);
  const checksum = createHash('sha256').update((definition || apply.toString()).replace(/\r\n/g,'\n')).digest('hex');
  const foreignKeys = sql.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (foreignKeysOff) sql.exec('PRAGMA foreign_keys=OFF');
  try {
    return atomicStorage(sql,'storage_migration',() => {
      const declaredTables = [...(definition || apply.toString()).matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match => match[1]);
      const adopted = declaredTables.length && declaredTables.every(name => tableExists(sql,name));
      sql.exec(`CREATE TABLE IF NOT EXISTS storage_migrations(
        component TEXT NOT NULL,version INTEGER NOT NULL,checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,release TEXT NOT NULL,origin TEXT NOT NULL,
        PRIMARY KEY(component,version));`);
      const previous = sql.prepare('SELECT checksum FROM storage_migrations WHERE component=? AND version=?').get(component,version);
      if (previous) {
        if (previous.checksum !== checksum) throw new StorageError('migration_checksum_mismatch');
        return false;
      }
      const latest = sql.prepare('SELECT MAX(version) AS version FROM storage_migrations WHERE component=?').get(component).version || 0;
      if (version !== latest+1) throw new StorageError('migration_order_mismatch');
      apply();
      if (foreignKeysOff && sql.prepare('PRAGMA foreign_key_check').get()) throw new StorageError('migration_foreign_key_failure');
      if (store) {
        sql.exec('CREATE TABLE IF NOT EXISTS storage_meta(id INTEGER PRIMARY KEY CHECK(id=1),store TEXT NOT NULL,format INTEGER NOT NULL)');
        sql.prepare('INSERT OR IGNORE INTO storage_meta(id,store,format) VALUES(1,?,1)').run(store);
        assertStorage(sql,store,{legacy:false});
      }
      sql.prepare('INSERT INTO storage_migrations(component,version,checksum,applied_at,release,origin) VALUES(?,?,?,?,?,?)')
        .run(component,version,checksum,new Date().toISOString(),revision,adopted ? 'legacy-baseline' : 'applied');
      return true;
    });
  } catch (error) {error.storageComponent = component;throw error;}
  finally {if (foreignKeysOff) sql.exec('PRAGMA foreign_keys='+Number(foreignKeys));}
}

// This table contains only disposable calculations, never source observations,
// schedules, accounts or delivery/outbox state. Call inside the reader's savepoint.
export function projectionVersion(sql,name,version,reset) {
  sql.exec('CREATE TABLE IF NOT EXISTS projection_versions(name TEXT PRIMARY KEY,version TEXT NOT NULL)');
  const previous = sql.prepare('SELECT version FROM projection_versions WHERE name=?').get(name)?.version;
  if (previous === String(version)) return;
  // Unversioned caches came from the unchanged v1 formulas in the bridge release.
  if (previous !== undefined || String(version) !== '1') reset();
  sql.prepare('INSERT INTO projection_versions(name,version) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version').run(name,String(version));
}
