import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {openQuery,overview,csvLine} from '../src/storage-browser.js';
import {storageBrowser} from '../src/storage-browser-http.js';
function fixture(t,count=251){
 const root=mkdtempSync(join(tmpdir(),'storage-browser-'));mkdirSync(join(root,'.data'));
 const sql=new DatabaseSync(join(root,'.data/prices.sqlite3'));sql.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,brand TEXT,url TEXT,image TEXT);
 CREATE TABLE variants(id INTEGER PRIMARY KEY,product_id INTEGER,sku TEXT,volume_ml TEXT,label TEXT);
 CREATE TABLE observations(id INTEGER PRIMARY KEY,variant_id INTEGER,check_id INTEGER,checked_at TEXT,context TEXT,price INTEGER,original_price INTEGER,in_stock INTEGER,status TEXT,source TEXT);
 INSERT INTO products VALUES(1,'Perfume 100%','Brand','','');INSERT INTO variants VALUES(1,1,'sku-1','1.5','sample');`);
 const insert=sql.prepare("INSERT INTO observations VALUES(?,1,1,?,'public',?,NULL,1,'ok','http')");
 sql.exec('BEGIN');for(let id=1;id<=count;id++)insert.run(id,id===1?'2026-10-28T21:00:00.000Z':'2026-10-29T12:00:00.000Z',id===1?null:100);sql.exec('COMMIT');
 t.after(()=>{sql.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 return {root,sql};
}
function read(root,params){const q=openQuery(root,params);try{return {rows:q.rows(),anchor:q.anchor,total:q.total,pages:q.pages,page:q.page};}finally{q.db.close();}}
test('numbered pages remain stable after new observations; all records are reachable',t=>{
 const {root,sql}=fixture(t),first=read(root,{size:'100'});
 assert.equal(first.total,251);assert.equal(first.pages,3);assert.equal(first.rows[0].id,251);
 sql.exec("INSERT INTO observations SELECT 252,variant_id,check_id,checked_at,context,price,original_price,in_stock,status,source FROM observations WHERE id=1");
 const second=read(root,{size:'100',page:'2',anchor:String(first.anchor)}),third=read(root,{size:'100',page:'3',anchor:String(first.anchor)});
 assert.equal(second.total,251);assert.equal(second.rows[0].id,151);assert.equal(third.rows.length,51);
 assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(row=>row.id)).size,251);
 assert.equal(read(root,{}).total,252);
});
test('filters use literal search, Moscow dates and deterministic ties; forbidden tables rejected',t=>{
 const {root,sql}=fixture(t);
 assert.equal(read(root,{q:'100%'}).total,251);assert.equal(read(root,{q:"' OR 1=1 --"}).total,0);
 assert.equal(read(root,{from:'2026-10-29',to:'2026-10-29'}).total,251);
 assert.equal(read(root,{from:'2026-10-30'}).total,0);
 assert.equal(read(root,{product_id:'2'}).total,0);
 assert.equal(read(root,{sort:'checked_at',direction:'asc'}).rows[0].price,null);
 for(const params of [{table:'settings'},{store:'../secret'},{table:'constructor'},{sort:'id; DROP TABLE products'},{size:'100000'},{page:'-1'},{from:'2026-02-31'}])assert.throws(()=>read(root,params));
 assert.equal(sql.prepare('SELECT count(*) n FROM products').get().n,1);
 assert.equal(overview(root).stores.find(s=>s.store==='ozon').ok,false);
});
test('CSV streams all filtered rows through the worker, escapes formulas and releases connections',async t=>{
 const {root}=fixture(t,1201);
 const server=createServer((req,res)=>storageBrowser(req,res,root,new URL(req.url,'http://localhost')));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
 const base='http://127.0.0.1:'+server.address().port;
 const all=await fetch(base+'/api/storage/export?store=randewoo&table=observations&scope=all&size=100');
 assert.equal(all.status,200);const csv=await all.text();assert.equal(csv.trim().split('\r\n').length,1202);
 const page=await fetch(base+'/api/storage/export?store=randewoo&table=observations&scope=page&size=50&page=2');
 assert.equal((await page.text()).trim().split('\r\n').length,51);
 assert.match(csvLine(['=HYPERLINK("bad")','a;b',null]),/^"'=HYPERLINK/);
 const bad=await fetch(base+'/api/storage/rows?table=mobile_device');assert.equal(bad.status,400);await bad.text();
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('deep pagination and a filtered count on 100,000 observations complete within query budget',t=>{
 const {root}=fixture(t,100000),start=performance.now();
 const page=read(root,{page:'1000',size:'100',product_id:'1'});
 assert.equal(page.rows.length,100);assert.equal(page.rows.at(-1).id,1);
 assert.ok(performance.now()-start<5000);
});
