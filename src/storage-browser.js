import {DatabaseSync} from 'node:sqlite';
import {statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {storePaths} from './storage-maintenance.js';

const spec = (table,columns,{key='id',date,search=[],append=false,filters={}}={}) => ({table,columns:columns.split(' '),key,date,search,append,filters});
const checks = spec('checks','id started_at finished_at trigger status completed total',{date:'started_at',search:['id'],filters:{status:'status',check_id:'id'},append:true});
const migrations = spec('storage_migrations','component version checksum applied_at release origin',{key:'rowid',date:'applied_at',append:true});
const common={checks,migrations};
export const catalogs = {
 randewoo:{...common,
  products:spec('products','id url brand name image',{search:['id','brand','name']}),
  variants:spec('variants','id product_id sku volume_ml label',{search:['id','sku'],filters:{product_id:'product_id'}}),
  observations:spec('observations','id variant_id check_id checked_at context price original_price in_stock status source',{date:'checked_at',search:['id'],append:true,filters:{product_id:'variant_id',check_id:'check_id',status:'status',availability:'in_stock'}})},
 ozon:{...common,
  products:spec('products','sku url title image_url created_at',{key:'sku',date:'created_at',search:['sku','title']}),
  observations:spec('observations','id sku check_id checked_at status availability listed_price_kopecks original_price_kopecks regular_kopecks ozon_card_kopecks source',{date:'checked_at',search:['id','sku'],append:true,filters:{product_id:'sku',check_id:'check_id',status:'status',availability:'availability'}})},
 lamoda:{...common,
  products:spec('products','sku title color url image_url position active',{key:'sku',search:['sku','title']}),
  observations:spec('observations','id sku check_id checked_at price_at price original_price availability status source',{date:'checked_at',search:['id','sku'],append:true,filters:{product_id:'sku',check_id:'check_id',status:'status',availability:'availability'}}),
  desktop_products:spec('desktop_products','sku title color url image_url position active',{key:'sku',search:['sku','title']}),
  desktop_observations:spec('desktop_observations','run_id sku checked_at price_at price original_price availability',{key:'rowid',date:'checked_at',search:['sku','run_id'],append:true,filters:{product_id:'sku',check_id:'run_id',availability:'availability'}}),
  desktop_snapshots:spec('desktop_snapshots','run_id received_at item_count',{key:'rowid',date:'received_at',search:['run_id'],append:true})},
 journal:{runs:spec('runs','id store reason started_at finished_at duration_seconds stage status error',{date:'started_at',search:['id','store','reason'],append:true,filters:{status:'status',store_filter:'store'}}),
  artifacts:spec('artifacts','id run_id store location locator created_at bytes verification verified_at availability checked_at origin',{date:'created_at',search:['id','store','locator'],append:true,filters:{status:'verification',availability:'availability',store_filter:'store',check_id:'run_id'}})}
};
export function databasePath(root,store) {
 if(store==='journal') return join(root,'.data/backup-journal/events.sqlite3');
 if(!Object.hasOwn(storePaths,store)) throw new Error('invalid_request');
 return join(root,'.data',storePaths[store]);
}
export function overview(root) {
 const stores=Object.keys(storePaths).map(store=>{
  let db;
  try {const path=databasePath(root,store);db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON');
   return {store,ok:true,bytes:statSync(path).size+(existsSync(path+'-wal')?statSync(path+'-wal').size:0),
    format:db.prepare('SELECT format FROM storage_meta WHERE id=1').get().format,
    projections:db.prepare('SELECT name,version FROM projection_versions').all()};
  } catch{return {store,ok:false};} finally{db?.close();}
 });
 let db;
 try {db=new DatabaseSync(databasePath(root,'journal'),{readOnly:true});
  const last=db.prepare("SELECT store,MAX(created_at) AS created_at,MAX(checked_at) AS checked_at FROM artifacts GROUP BY store").all();
  return {stores,journal:{ok:true,last},catalogs};
 } catch{return {stores,journal:{ok:false,last:[]},catalogs};} finally{db?.close();}
}
const integer = (value,fallback,min=1,max=Number.MAX_SAFE_INTEGER) => {
 if(value==null || value==='') return fallback;
 if(!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw Error('invalid_request');
 return Number(value);
};
export function openQuery(root,params,{cachedTotal}={}) {
 const store=params.store || 'randewoo',table=params.table || 'observations';
 const descriptor=catalogs[store]?.[table];
 if(!descriptor || !Object.hasOwn(catalogs,store) || !Object.hasOwn(catalogs[store],table)) throw Error('invalid_request');
 const size=integer(params.size,100,1,200);if(![50,100,200].includes(size)) throw Error('invalid_request');
 const page=integer(params.page,1,1,100000000);
 const sort=params.sort || descriptor.key;
 if(!descriptor.columns.includes(sort) && sort!==descriptor.key) throw Error('invalid_request');
 if(params.direction && !['asc','desc'].includes(params.direction)) throw Error('invalid_request');
 const direction=params.direction==='asc'?'ASC':'DESC';
 const db=new DatabaseSync(databasePath(root,store),{readOnly:true});
 try {
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
  const available=new Set(db.prepare(`PRAGMA table_info("${descriptor.table}")`).all().map(c=>c.name));
  if(!available.size) throw Error('table_unavailable');
  const columns=descriptor.columns.filter(c=>available.has(c));
  if(sort!=='rowid'&&!available.has(sort)) throw Error('invalid_request');
  const where=[],bindings=[];
  let anchor=null;
  if(descriptor.append){anchor=integer(params.anchor,db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM "${descriptor.table}"`).get().n,0);
   where.push('t.rowid<=?');bindings.push(anchor);}
  for(const [parameter,column] of Object.entries(descriptor.filters)) if(params[parameter]){
   if(String(params[parameter]).length>150) throw Error('invalid_request');
   where.push(`t."${column}"=?`);bindings.push(params[parameter]);}
  if(params.q){
   if(params.q.length>150) throw Error('invalid_request');
   const fields=descriptor.search;
   if(!fields.length) throw Error('invalid_request');
   const conditions=fields.map(c=>`CAST(t."${c}" AS TEXT) LIKE ? ESCAPE '\\'`);
   const query='%'+params.q.replace(/[\\%_]/g,'\\$&')+'%';
   bindings.push(...fields.map(()=>query));
   if(table==='observations'){
    if(store==='randewoo') conditions.push("t.variant_id IN (SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')");
    else conditions.push("t.sku IN (SELECT sku FROM products WHERE title LIKE ? ESCAPE '\\')");
    bindings.push(query);if(store==='randewoo') bindings.push(query);
   }
   where.push('('+conditions.join(' OR ')+')');
  }
  for(const [parameter,operator] of [['from','>='],['to','<']]) if(params[parameter]){
   if(!descriptor.date || !/^\d{4}-\d{2}-\d{2}$/.test(params[parameter])) throw Error('invalid_request');
   const stamp=Date.parse(params[parameter]+'T00:00:00+03:00');
   if(!Number.isFinite(stamp)||new Date(stamp+10800000).toISOString().slice(0,10)!==params[parameter]) throw Error('invalid_request');
   where.push(`t."${descriptor.date}" ${operator} ?`);bindings.push(new Date(stamp+(parameter==='to'?86400000:0)).toISOString());
  }
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const source=`FROM "${descriptor.table}" t${clause}`;
  const total=cachedTotal??db.prepare('SELECT COUNT(*) AS n '+source).get(...bindings).n;
  const pages=Math.max(1,Math.ceil(total/size)),actualPage=Math.min(page,pages);
  const order=` ORDER BY t."${sort}" ${direction},t."${descriptor.key}" ${direction}`;
  const select='SELECT '+columns.map(c=>`t."${c}"`).join(',')+' '+source+order;
  return {db,columns,total,pages,page:actualPage,size,anchor,select,bindings,
   rows:()=>db.prepare(select+' LIMIT ? OFFSET ?').all(...bindings,size,(actualPage-1)*size)};
 } catch(error){db.close();throw error;}
}
export function csvLine(values) {
 return values.map(value=>{let text=value==null?'':String(value);if(/^\s*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}).join(';')+'\r\n';
}
