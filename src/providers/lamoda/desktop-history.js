import {ValidationError} from '../../errors.js';
import {LamodaError,validSku} from './parser.js';
import {HistoryCache,RowCache,compositionKey,emptySummary,recordPrice,publicSummary,appendSparkline} from '../../dashboard-cache.js';

const reason = code => new LamodaError(code).message;

export class DesktopHistory {
  constructor(db,current = Date.now) {
    this.db = db;this.sql = db.db;this.current = current;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS desktop_products(sku TEXT PRIMARY KEY,title TEXT NOT NULL,color TEXT NOT NULL,
      url TEXT NOT NULL,image_url TEXT,position INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS desktop_indexed(run_id TEXT PRIMARY KEY REFERENCES desktop_snapshots(run_id));
      CREATE TABLE IF NOT EXISTS desktop_observations(run_id TEXT NOT NULL REFERENCES desktop_snapshots(run_id),sku TEXT NOT NULL,
        checked_at TEXT NOT NULL,price_at TEXT,price INTEGER,original_price INTEGER,availability TEXT NOT NULL,
        PRIMARY KEY(run_id,sku));
      CREATE INDEX IF NOT EXISTS desktop_observations_sku ON desktop_observations(sku,checked_at DESC);`);
    this.rowCache = new RowCache(this.sql,{name:'desktop_rows',table:'desktop_observations',key:'sku',chronological:true,reverseTies:true,
      initial:() => ({latest:null,summary:emptySummary(),sparkline:[]}),reduce:(state,row) => {
        state.latest = row;
        if (row.availability !== 'unavailable' && row.price != null) recordPrice(state.summary,row.price,row.checked_at);
        appendSparkline(state,row);
      }});
    this.historyCache = new HistoryCache(this.sql,{name:'desktop_history',scopes:['favorites'],order:'stamp,event',sources:[
      {table:'desktop_snapshots',event:row => `'s:'||${row}.run_id`},
      {table:'desktop_observations',event:row => `'s:'||${row}.run_id`},
      {table:'desktop_failures',event:row => `'f:'||${row}.id`},
    ]});
    const missing = this.sql.prepare(`SELECT run_id,received_at,items_json FROM desktop_snapshots s
      WHERE NOT EXISTS(SELECT 1 FROM desktop_indexed i WHERE i.run_id=s.run_id) ORDER BY received_at`).all();
    for (const row of missing) db.transaction(() => this.index(row.run_id,row.received_at,JSON.parse(row.items_json)));
  }
  index(runId,at,items) {
    this.sql.prepare('UPDATE desktop_products SET active=0').run();
    for (const [position,item] of items.entries()) {
      const previous = this.sql.prepare(`SELECT price,original_price,price_at FROM desktop_observations
        WHERE sku=? AND availability<>'unavailable' AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1`).get(item.sku);
      const unavailable = item.availability === 'unavailable';
      const price = unavailable ? previous?.price ?? null : item.price;
      const original = unavailable ? previous?.original_price ?? null : item.original_price;
      const priceAt = unavailable ? previous?.price_at ?? null : price === null ? null : at;
      this.sql.prepare(`INSERT INTO desktop_products VALUES(?,?,?,?,?,?,1) ON CONFLICT(sku) DO UPDATE SET
        title=excluded.title,color=excluded.color,url=excluded.url,image_url=excluded.image_url,position=excluded.position,active=1`)
        .run(item.sku,item.title,item.color,item.url,item.image_url,position);
      this.sql.prepare('INSERT OR IGNORE INTO desktop_observations VALUES(?,?,?,?,?,?,?)')
        .run(runId,item.sku,at,priceAt,price,original,item.availability);
    }
    this.sql.prepare('INSERT OR IGNORE INTO desktop_indexed(run_id) VALUES(?)').run(runId);
    this.historyCache.refreshAll((scope,events) => this.buildHistory(events));
  }
  summary(sku) {
    return publicSummary(this.rowCache.read([sku]).get(sku).summary);
  }
  point(row) {return {...row,status:'ok',in_stock:row.availability === 'unknown' ? null : row.availability === 'available'};}
  row(product,lastFailure,state = null) {
    const {latest,summary,sparkline:readings} = state || this.rowCache.read([product.sku]).get(product.sku);
    const failed = lastFailure && latest && lastFailure.at > latest.checked_at;
    const sparkline = readings.map(point => this.point(point));
    if (failed) sparkline.push({checked_at:lastFailure.at,price:latest.price,status:'error',message:reason(lastFailure.code)});
    return {...product,id:'lamoda:item:'+product.sku,status:failed ? 'error' : 'ok',
      checked_at:failed ? lastFailure.at : latest?.checked_at ?? null,price:latest?.price ?? null,
      original_price:latest?.original_price ?? null,price_at:latest?.price_at ?? null,
      availability:latest?.availability ?? 'unknown',message:failed ? reason(lastFailure.code) : '',
      ...publicSummary(summary),sparkline};
  }
  dashboard() {
    const cutoff = new Date(this.current()-30*86400000).toISOString();
    const lastFailure = this.sql.prepare('SELECT at,code FROM desktop_failures ORDER BY id DESC LIMIT 1').get();
    const products = this.sql.prepare('SELECT * FROM desktop_products WHERE active=1 ORDER BY position').all();
    const states = this.rowCache.read(products.map(product => product.sku));
    const items = products.map(product => this.row(product,lastFailure,states.get(product.sku)));
    const points = this.historyCache.read('favorites',cutoff,events => this.buildHistory(events));
    const snapshots = points.filter(point => point.kind === 'snapshot').slice(-1000);
    const failures = points.filter(point => point.kind === 'failure').sort((a,b) => b.failure_id-a.failure_id).slice(0,1000);
    const history = [...snapshots,...failures].map(({kind,run_id,failure_id,...point}) => point)
      .sort((a,b) => a.checked_at.localeCompare(b.checked_at));
    const activity = [...snapshots.map(row => ({at:row.checked_at,status:'success',count:row.count,run_id:row.run_id})),
      ...failures.map(row => ({at:row.checked_at,status:'error',count:0,message:row.message}))]
      .sort((a,b) => b.at.localeCompare(a.at)).slice(0,20);
    return {items,history,activity};
  }
  buildHistory(events = null) {
    const snapshots = this.sql.prepare(`SELECT s.run_id,s.received_at,s.item_count,
      COALESCE(SUM(CASE WHEN o.availability='available' AND o.price IS NOT NULL THEN o.price ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN o.availability='available' AND o.price IS NOT NULL THEN 1 ELSE 0 END),0) AS priced_count,
      GROUP_CONCAT(o.sku) AS members,
      GROUP_CONCAT(CASE WHEN o.availability='available' AND o.price IS NOT NULL THEN o.sku END) AS priced
      FROM desktop_snapshots s LEFT JOIN desktop_observations o ON o.run_id=s.run_id
      ${events === null ? '' : "WHERE s.run_id IN (SELECT substr(value,3) FROM json_each(?) WHERE value LIKE 's:%')"}
      GROUP BY s.run_id ORDER BY s.received_at`).all(...(events === null ? [] : [JSON.stringify(events)]));
    const history = snapshots.map(row => ({key:'s:'+row.run_id,stamp:row.received_at,position:0,point:{kind:'snapshot',run_id:row.run_id,
      checked_at:row.received_at,price:row.priced_count ? row.total : null,
      status:row.priced_count === row.item_count ? 'ok' : 'missing',count:row.item_count,priced_count:row.priced_count,
      complete:row.priced_count === row.item_count,composition:compositionKey([row.members,row.priced])}}));
    const failures = this.sql.prepare(`SELECT id,at,code FROM desktop_failures
      ${events === null ? '' : "WHERE id IN (SELECT substr(value,3) FROM json_each(?) WHERE value LIKE 'f:%')"} ORDER BY id`)
      .all(...(events === null ? [] : [JSON.stringify(events)]));
    for (const failure of failures) history.push({key:'f:'+failure.id,stamp:failure.at,position:failure.id,
      point:{kind:'failure',failure_id:failure.id,checked_at:failure.at,price:null,status:'error',message:reason(failure.code)}});
    return history;
  }
  detail(id,days = 30) {
    const sku = typeof id === 'string' && id.startsWith('lamoda:item:') ? id.slice(12) : '';
    if (!validSku(sku) || ![0,7,30,90,365].includes(days)) throw new ValidationError('Некорректный товар или период Lamoda.');
    const product = this.sql.prepare('SELECT * FROM desktop_products WHERE sku=?').get(sku);
    if (!product) throw new ValidationError('Товар ПК не найден.');
    const cutoff = days ? new Date(this.current()-days*86400000).toISOString() : '';
    const points = this.sql.prepare(`SELECT * FROM desktop_observations WHERE sku=? AND checked_at>=?
      ORDER BY checked_at DESC LIMIT 5000`).all(sku,cutoff).reverse().map(point => this.point(point));
    const failures = this.sql.prepare('SELECT at,code FROM desktop_failures WHERE at>=? ORDER BY id DESC LIMIT 1000').all(cutoff);
    for (const failure of failures) {
      const previous = [...points].reverse().find(point => point.checked_at < failure.at);
      if (previous) points.push({...previous,checked_at:failure.at,status:'error',message:reason(failure.code)});
    }
    points.sort((a,b) => a.checked_at.localeCompare(b.checked_at));
    const lastFailure = this.sql.prepare('SELECT at,code FROM desktop_failures ORDER BY id DESC LIMIT 1').get();
    return {product:this.row(product,lastFailure),points};
  }
}
