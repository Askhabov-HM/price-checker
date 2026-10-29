import {migrate,assertStorage,atomicStorage} from './storage-migrations.js';

export function migrateRandewoo(sql) {
  assertStorage(sql,'randewoo');
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  migrate(sql,{component:'migrateRandewoo',version:1,store:'randewoo',foreignKeysOff:true,apply:() => {
    sql.exec(`
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
    const schema = sql.prepare("SELECT sql FROM sqlite_master WHERE name='variants'").get().sql;
    if (/UNIQUE\s*\(\s*product_id\s*,\s*volume_ml\s*\)/i.test(schema)) {
      sql.exec(`
        CREATE TABLE variants_new(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),
          volume_ml TEXT NOT NULL DEFAULT '1.5',sku TEXT,label TEXT NOT NULL DEFAULT '1,5 мл',UNIQUE(product_id,sku));
        INSERT INTO variants_new SELECT * FROM variants;
        DROP TABLE variants;
        ALTER TABLE variants_new RENAME TO variants;`);
    }
    const observationSchema = sql.prepare("SELECT sql FROM sqlite_master WHERE name='observations'").get().sql;
    if (/UNIQUE\s*\(\s*variant_id\s*,\s*checked_at\s*,\s*context\s*\)/i.test(observationSchema)) {
      // Independent checks can finish in the same second. Preserve every event and its original ID.
      atomicStorage(sql,'legacy_observations',() => sql.exec(`CREATE TABLE observations_new(
          id INTEGER PRIMARY KEY,variant_id INTEGER NOT NULL REFERENCES variants(id),check_id INTEGER REFERENCES checks(id),
          checked_at TEXT NOT NULL,context TEXT NOT NULL,price INTEGER,original_price INTEGER,in_stock INTEGER,status TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '');
        INSERT INTO observations_new(id,variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source)
          SELECT id,variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source FROM observations;
        DROP TABLE observations;
        ALTER TABLE observations_new RENAME TO observations;
        CREATE INDEX observation_lookup ON observations(variant_id,context,checked_at DESC,id DESC);`));
    }
    // Create after legacy table migrations, which replace observations and its indexes.
    sql.exec('CREATE INDEX IF NOT EXISTS observation_history ON observations(context,check_id,checked_at,id)');
    sql.exec(`CREATE INDEX IF NOT EXISTS observation_check ON observations(check_id,variant_id,context,id);
      CREATE INDEX IF NOT EXISTS observation_previous ON observations(variant_id,context,id DESC);`);
  }});
}

export function migrateOzon(sql) {
  assertStorage(sql,'ozon');
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  migrate(sql,{component:'migrateOzon',version:1,store:'ozon',apply:() => {
      sql.exec(`
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
      if (!sql.prepare('PRAGMA table_info(observations)').all().some(column => column.name === 'source')) sql.exec("ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'http'");
      if (!sql.prepare('PRAGMA table_info(observations)').all().some(column => column.name === 'listed_price_kopecks')) sql.exec('ALTER TABLE observations ADD COLUMN listed_price_kopecks INTEGER');
      if (!sql.prepare('PRAGMA table_info(observations)').all().some(column => column.name === 'original_price_kopecks')) sql.exec('ALTER TABLE observations ADD COLUMN original_price_kopecks INTEGER');
      const stateColumns = new Set(sql.prepare('PRAGMA table_info(collector_state)').all().map(column => column.name));
      for (const [name,definition] of Object.entries({schedule_mode:"TEXT NOT NULL DEFAULT 'interval'",schedule:"TEXT NOT NULL DEFAULT '[\"00:00\"]'",interval_minutes:'INTEGER NOT NULL DEFAULT 30',schedule_anchor:'TEXT'})) {
        if (!stateColumns.has(name)) sql.exec(`ALTER TABLE collector_state ADD COLUMN ${name} ${definition}`);
      }
      sql.exec(`CREATE INDEX IF NOT EXISTS seller_events_product ON seller_events(sku,id DESC);
        CREATE INDEX IF NOT EXISTS checks_finished ON checks(finished_at,id);`);
  }});
}

export function migrateLamoda(sql) {
  assertStorage(sql,'lamoda');
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  migrate(sql,{component:'migrateLamoda',version:1,store:'lamoda',apply:() => {
sql.exec(`
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
      INSERT OR IGNORE INTO notification_state(id) VALUES(1);`);
  }});
}

export function migrateMobile(sql) {
  migrate(sql,{component:'migrateMobile',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS mobile_device(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL,name TEXT NOT NULL,last_seen TEXT);
      CREATE TABLE IF NOT EXISTS mobile_pairing(id INTEGER PRIMARY KEY CHECK(id=1),code_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mobile_jobs(id TEXT PRIMARY KEY,check_id INTEGER NOT NULL REFERENCES checks(id),status TEXT NOT NULL,expires INTEGER NOT NULL,
        next_page INTEGER NOT NULL DEFAULT 1,result TEXT,error TEXT,bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mobile_pages(job_id TEXT NOT NULL REFERENCES mobile_jobs(id) ON DELETE CASCADE,page INTEGER NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,page));
      CREATE TABLE IF NOT EXISTS mobile_diagnostics(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,event TEXT NOT NULL,at TEXT NOT NULL,
        page INTEGER,reason TEXT,screen_locked INTEGER,screen_off INTEGER);
      CREATE INDEX IF NOT EXISTS mobile_diagnostics_job ON mobile_diagnostics(job_id,id);`);
  }});
}

export function migratePush(sql) {
  migrate(sql,{component:'migratePush',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS mobile_push_device(id INTEGER PRIMARY KEY CHECK(id=1),device_hash TEXT NOT NULL,
      token TEXT,enabled INTEGER NOT NULL DEFAULT 0,registered_at TEXT,accepted_at TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS mobile_push_outbox(job_id TEXT PRIMARY KEY REFERENCES mobile_jobs(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,accepted_at TEXT);`);
  }});
}

export function migrateDesktop(sql) {
  migrate(sql,{component:'migrateDesktop',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_device(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL,name TEXT NOT NULL,last_seen TEXT);
      CREATE TABLE IF NOT EXISTS desktop_pairing(id INTEGER PRIMARY KEY CHECK(id=1),code_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_state(id INTEGER PRIMARY KEY CHECK(id=1),not_before TEXT);
      INSERT OR IGNORE INTO desktop_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS desktop_failures(id INTEGER PRIMARY KEY,at TEXT NOT NULL,code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_snapshots(run_id TEXT PRIMARY KEY,received_at TEXT NOT NULL,account_digest TEXT NOT NULL,
        item_count INTEGER NOT NULL,payload_hash TEXT NOT NULL,items_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_snapshots_received ON desktop_snapshots(received_at DESC);`);
    const columns = new Set(sql.prepare('PRAGMA table_info(desktop_state)').all().map(row => row.name));
    if (!columns.has('schedule_enabled')) sql.exec('ALTER TABLE desktop_state ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('next_check')) sql.exec('ALTER TABLE desktop_state ADD COLUMN next_check TEXT');
    if (!columns.has('action_required')) sql.exec('ALTER TABLE desktop_state ADD COLUMN action_required INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('last_error')) sql.exec('ALTER TABLE desktop_state ADD COLUMN last_error TEXT');
  }});
}

export function migrateDesktopHistory(sql) {
  migrate(sql,{component:'migrateDesktopHistory',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_products(sku TEXT PRIMARY KEY,title TEXT NOT NULL,color TEXT NOT NULL,
      url TEXT NOT NULL,image_url TEXT,position INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS desktop_indexed(run_id TEXT PRIMARY KEY REFERENCES desktop_snapshots(run_id));
      CREATE TABLE IF NOT EXISTS desktop_observations(run_id TEXT NOT NULL REFERENCES desktop_snapshots(run_id),sku TEXT NOT NULL,
        checked_at TEXT NOT NULL,price_at TEXT,price INTEGER,original_price INTEGER,availability TEXT NOT NULL,
        PRIMARY KEY(run_id,sku));
      CREATE INDEX IF NOT EXISTS desktop_observations_sku ON desktop_observations(sku,checked_at DESC);`);
  }});
}

export function migrateTelegram(sql) {
  migrate(sql,{component:'migrateTelegram',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS telegram_outbox(
      check_id INTEGER NOT NULL REFERENCES checks(id),owner_id INTEGER NOT NULL,text TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,
      PRIMARY KEY(check_id,owner_id))`);
  }});
}

export function migrateOzonTelegram(sql) {
  migrate(sql,{component:'migrateOzonTelegram',version:1,apply:() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS telegram_ozon_outbox(
        check_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,
        PRIMARY KEY(check_id,owner_id))`);
  }});
}

export function migrateCodex(sql) {
  migrate(sql,{component:'migrateCodex',version:1,apply:() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS telegram_dialogues(
      id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,created_at TEXT NOT NULL,session_id TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS telegram_ai_messages(
      update_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,dialogue_id INTEGER NOT NULL REFERENCES telegram_dialogues(id),
      prompt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',answer TEXT,created_at TEXT NOT NULL,finished_at TEXT,
      next_part INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(update_id,owner_id))`);
  }});
}
