import {parentPort,workerData} from 'node:worker_threads';
import {openQuery,overview,csvLine} from './storage-browser.js';
let query;
const emit = value => parentPort.postMessage(value);
try {
 if(workerData.action==='overview') emit({type:'result',value:overview(workerData.root)});
 else {
  query=openQuery(workerData.root,workerData.params,{cachedTotal:workerData.cachedTotal});
  const {columns,total,pages,page,size,anchor}=query;
  if(workerData.action==='rows') emit({type:'result',value:{columns,total,pages,page,size,anchor,rows:query.rows()}});
  else {
   const acknowledge=()=>new Promise(resolve=>parentPort.once('message',resolve));
   const send=async text=>{const ready=acknowledge();emit({type:'chunk',text});await ready;};
   const journal=workerData.params.store==='journal';
   if(journal)query.db.exec('COMMIT');
   await send('\ufeff'+csvLine(columns));
   const statement=query.db.prepare(query.select+(workerData.params.scope==='page'?' LIMIT ? OFFSET ?':''));
   const args=workerData.params.scope==='page'?[...query.bindings,size,(page-1)*size]:query.bindings;
   if(journal){
    // Never keep the operational journal read-locked while waiting for a slow download.
    const limit=workerData.params.scope==='page'?size:total;
    const start=workerData.params.scope==='page'?(page-1)*size:0;
    const batch=query.db.prepare(query.select+' LIMIT ? OFFSET ?');
    for(let offset=0;offset<limit;offset+=500){
     query.db.exec('BEGIN');
     const rows=batch.all(...query.bindings,Math.min(500,limit-offset),start+offset);
     query.db.exec('COMMIT');
     if(!rows.length)break;
     await send(rows.map(row=>csvLine(columns.map(c=>row[c]))).join(''));
    }
   } else {
    let chunk='',count=0;
    for(const row of statement.iterate(...args)) {chunk+=csvLine(columns.map(c=>row[c]));if(++count%500===0){await send(chunk);chunk='';}}
    if(chunk)await send(chunk);
   }
   emit({type:'end'});
  }
 }
} catch(error){emit({type:'error',reason:['invalid_request','table_unavailable'].includes(error.message)?error.message:'storage_unavailable'});}
finally {query?.db.close();parentPort.close();}
