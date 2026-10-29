import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Database,LISTS,CONTEXTS} from './database.js';
import {OzonDatabase} from './providers/ozon/database.js';
import {LamodaDatabase} from './providers/lamoda/database.js';
import {DesktopHistory} from './providers/lamoda/desktop-history.js';
import {migrateMobile,migratePush,migrateDesktop,migrateTelegram,migrateOzonTelegram,migrateCodex} from './storage-schema.js';
import {assertStorage,atomicStorage,StorageError,tableExists,storageContract,publishedVersion} from './storage-migrations.js';

export const storePaths = {randewoo:'prices.sqlite3',ozon:'ozon/prices.sqlite3',lamoda:'lamoda/prices.sqlite3'};
export const existingStores = root => Object.keys(storePaths).filter(store => existsSync(join(root,'.data',storePaths[store])));
export function deploymentState(root) {
  const path = join(root,'.data/deployment.json');
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path,'utf8'));
    if (!['drain','prepare','validate','blocked'].includes(state.phase)) throw new Error();
    return state;
  } catch {return {phase:'blocked'};}
}
export function checkStores(root,{stores = existingStores(root),legacy = true} = {}) {
  const results = {};
  for (const store of stores) {
    let sql;
    try {
      if (!Object.hasOwn(storePaths,store)) throw new StorageError('unknown_store');
      sql = new DatabaseSync(join(root,'.data',storePaths[store]),{readOnly:true});
      assertStorage(sql,store,{legacy});
      if (sql.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || sql.prepare('PRAGMA foreign_key_check').get()) throw new StorageError('storage_integrity_failure');
      results[store] = {ok:true,format:tableExists(sql,'storage_meta') ? sql.prepare('SELECT format FROM storage_meta WHERE id=1').get().format : 1};
    } catch (error) {results[store] = {ok:false,reason:error instanceof StorageError ? error.code : 'storage_unavailable'};}
    finally {sql?.close();}
  }
  return {ok:Object.values(results).every(result => result.ok),stores:results};
}

// Only called with writers stopped and all instance/collector locks held.
// No service constructors, network requests, credentials or notifications.
export function prepareStores(root,{stores = existingStores(root)} = {}) {
  const before = checkStores(root,{stores});
  if (!before.ok) throw new StorageError('storage_preflight_failed');
  for (const store of stores) {
    let db;
    try {
      db = store === 'randewoo' ? new Database(join(root,'.data',storePaths[store]))
        : store === 'ozon' ? new OzonDatabase(root) : new LamodaDatabase(root);
      const sql = db.connection || db.db;
      if (store === 'randewoo') {migrateTelegram(sql);migrateOzonTelegram(sql);migrateCodex(sql);}
      if (store === 'lamoda') {migrateMobile(sql);migratePush(sql);migrateDesktop(sql);}
      atomicStorage(sql,'deployment_recovery',() => {
        sql.prepare("UPDATE checks SET status='interrupted',finished_at=?,message=? WHERE status='running'")
          .run(new Date().toISOString(),'Проверка прервана обновлением приложения.');
        if (store === 'lamoda') sql.exec("UPDATE mobile_jobs SET status='canceled',result=NULL WHERE status='pending'");
      });
      // Warm all rows (including archived items) and all graph scopes before readiness.
      if (store === 'randewoo') {
        const keys = sql.prepare('SELECT id FROM variants').all().map(row => row.id);
        for (const context of Object.keys(CONTEXTS)) db.rowCache.read(keys,context);
        for (const list of Object.keys(LISTS)) for (const context of Object.keys(CONTEXTS)) db.listHistory(list,context,0);
      } else {
        db.rowCache.read(sql.prepare('SELECT sku FROM products').all().map(row => row.sku));
        db.historyCache.refreshAll((scope,events) => store === 'ozon' ? db.buildListHistory(scope,events) : db.buildListHistory(events));
      }
      db.published.read(() => {});
      if (store === 'lamoda') {
        const desktop = new DesktopHistory(db);
        desktop.rowCache.read(sql.prepare('SELECT sku FROM desktop_products').all().map(row => row.sku));
        desktop.historyCache.refreshAll((scope,events) => desktop.buildHistory(events));
      }
    } catch (error) {error.store = store;throw error;}
    finally {db?.close();}
  }
  const result = checkStores(root,{stores,legacy:false});
  if (!result.ok) throw new StorageError('storage_postflight_failed');
  return result;
}

// Public health exposes readiness, never schema contents or account identifiers.
export function runtimeReadiness(services,required) {
  const stores = {};
  for (const store of required) {
    try {
      const db = services[store]?.db;
      const sql = db?.connection || db?.db;
      if (!sql || services[store].storageReady === false) throw new Error();
      assertStorage(sql,store,{legacy:false});
      sql.prepare('SELECT id FROM checks LIMIT 1').get();
      const versions = Object.fromEntries(sql.prepare('SELECT name,version FROM projection_versions').all().map(row => [row.name,row.version]));
      const expected = {price_rows:String(storageContract.projections.rows),list_history:String(storageContract.projections.history),collection_snapshot:publishedVersion()};
      if (store === 'lamoda' && tableExists(sql,'desktop_products')) Object.assign(expected,{desktop_rows:String(storageContract.projections.rows),desktop_history:String(storageContract.projections.history)});
      if (Object.entries(expected).some(([key,value]) => versions[key] !== value)) throw new Error();
      stores[store] = {ok:true};
    } catch {stores[store] = {ok:false};}
  }
  return {ok:Object.values(stores).every(store => store.ok),stores,storage_protocol:storageContract.protocol};
}

export function warmRuntime(services) {
  for (const service of Object.values(services)) if (service) {
    try {
      const db = service.db;
      for (const scope of db.published.scopes) db.published.dashboard(scope);
      service.desktop?.dashboard();
      service.storageReady = true;
    } catch {service.storageReady = false;}
  }
}
