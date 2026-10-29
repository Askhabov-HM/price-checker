import {Worker} from 'node:worker_threads';
let active=0;
const counts=new Map();
const cacheKey=(root,params)=>JSON.stringify([root,...Object.entries(params).filter(([key])=>!['page','size','scope','sort','direction'].includes(key)).sort()]);
export async function storageBrowser(request,response,root,url) {
 if(active>=2){response.writeHead(503,{'Content-Type':'application/json','Retry-After':'2'});response.end(JSON.stringify({error:'Просмотр занят. Повторите запрос.'}));return;}
 const action=url.pathname.split('/').at(-1);
 if(!['overview','rows','export'].includes(action)){response.writeHead(404);response.end();return;}
 const params=Object.fromEntries(url.searchParams);
 if(action==='export'&&!['page','all'].includes(params.scope)){response.writeHead(400);response.end();return;}
 const cacheable=['observations','desktop_observations'].includes(params.table)&&params.anchor!==undefined&&!params.q;
 const cache=cacheable?counts.get(cacheKey(root,params)):null;
 active++;
 const worker=new Worker(new URL('./storage-browser-worker.js',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:128},workerData:{root,params,action,cachedTotal:cache?.expires>Date.now()?cache.total:undefined}});
 await new Promise(resolve=>{
  let finished=false;
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);active--;void worker.terminate();response.off('close',finish);resolve();};
  const fail=reason=>{
   if(response.headersSent)response.destroy();
   else {response.writeHead(reason==='invalid_request'?400:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    response.end(JSON.stringify({error:reason==='invalid_request'?'Некорректные параметры просмотра.':'Хранилище или таблица недоступны. Повторите запрос позже.'}));}
   finish();
  };
  const timer=setTimeout(()=>fail('timeout'),action==='export'?120000:20000);
  response.once('close',finish);
  worker.on('error',()=>fail('storage_unavailable'));
  worker.on('exit',()=>{if(!finished)fail('storage_unavailable');});
  worker.on('message',message=>{
   if(finished)return;
   if(message.type==='error')return fail(message.reason);
   if(message.type==='result'){
    if(action==='rows'&&['observations','desktop_observations'].includes(params.table)&&!params.q){
     if(counts.size>=128)counts.delete(counts.keys().next().value);
     counts.set(cacheKey(root,{...params,anchor:String(message.value.anchor)}),{total:message.value.total,expires:Date.now()+30000});
    }
    response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(JSON.stringify(message.value));finish();
   } else if(message.type==='chunk'){
    if(!response.headersSent)response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store',
     'X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="price-checker-records.csv"'});
    if(response.write(message.text))worker.postMessage('next');else response.once('drain',()=>{if(!finished)worker.postMessage('next');});
   } else if(message.type==='end'){response.end();finish();}
  });
 });
}
