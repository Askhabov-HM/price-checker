import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OzonClient} from '../src/providers/ozon/client.js';
import {browserCollection} from '../src/providers/ozon/recovery.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {writePrivateJson} from '../src/providers/ozon/session.js';
import {acquireInstance} from '../src/instance.js';

const root='/opt/price-checker/current',baselinePath=process.argv[2];
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
let db,client,release,check,committed=false;
const startedAt=new Date().toISOString(),requests=[],failures=[];
const output=join(root,'.secrets/ozon/once-check-last.json');
try {
  if(!/^\/var\/lib\/price-checker\/secrets\/ozon\/once-baseline-[0-9TZ]+\.json$/.test(baselinePath||''))throw Error('Invalid baseline path');
  const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));
  release=await acquireInstance(join(root,'.data/ozon/collector.lock'));
  db=new OzonDatabase(root);
  const state=db.state();
  if(state.not_before && Date.parse(state.not_before)>Date.now())throw Error('Ozon requested a later retry');
  check=db.begin('schedule',startedAt);
  client=new OzonClient(root,{browser:async options=>{
    const channel=browserCollection(options);
    return {
      async read(request){
        const outer=new URL(request.url),page=new URL(outer.searchParams.get('url'),'https://www.ozon.ru');
        if(request.method!=='GET' || outer.origin!=='https://www.ozon.ru' || outer.pathname!=='/api/entrypoint-api.bx/page/json/v2'
          || page.origin!==outer.origin || page.pathname!=='/my/favorites')throw Error('Only favorites pages may be requested');
        const response=await channel.read(request);requests.push({status:response.http_status});return response;
      },
      close:()=>channel.close(),
    };
  }});const contextDigest=await client.open(controller.signal);
  const lists=await client.lists(),items=lists.favorites.map(item=>db.withSavedPrice(item));
  const old=new Map(baseline.items.map(item=>[item.sku,item]));
  const unavailable=items.filter(item=>['out_of_stock','unavailable'].includes(item.availability));
  db.progress(check,items.length);
  const changes=items.filter(item=>{
    const before=old.get(item.external_id);
    return before&&(before.listed_price_kopecks!==item.listed_price_kopecks || before.original_price_kopecks!==item.original_price_kopecks);
  }).map(item=>({sku:item.external_id,title:item.title,before:old.get(item.external_id).listed_price_kopecks,after:item.listed_price_kopecks,
    original_before:old.get(item.external_id).original_price_kopecks,original_after:item.original_price_kopecks}));
  const present=new Set(items.map(item=>item.external_id)),finishedAt=new Date().toISOString();
  const report={status:'success',started_at:startedAt,finished_at:finishedAt,baseline_at:baseline.captured_at,check_id:check,
    count:items.length,priced:items.filter(item=>item.listed_price_kopecks!==null).length,
    missing:items.filter(item=>item.listed_price_kopecks===null).map(item=>({sku:item.external_id,title:item.title})),
    price_changes:changes,added:items.filter(item=>!old.has(item.external_id)).map(item=>item.external_id),
    removed:baseline.items.filter(item=>!present.has(item.sku)).map(item=>item.sku),
    unavailable_checked:0,unavailable_skipped:unavailable.length,retained_prices:unavailable.filter(item=>item.price_retained).length,
    refreshed_prices:items.filter(item=>!['out_of_stock','unavailable'].includes(item.availability) && item.listed_price_kopecks!==null).length,
    individual_product_requests:0,requests:requests.length,failures,schedule_enabled:!!db.state().schedule_enabled};
  // Store availability changes while retaining old prices and their original dates.
  db.bindContext(contextDigest,{legacyDigest:client.legacyContextDigest});
  db.recordFavorites(check,items,finishedAt,client.source);
  committed=true;
  db.finish(check,'success',`Разовая проверка: ${items.length} товаров, обновлено цен ${report.refreshed_prices}, сохранено прежних ${report.retained_prices}, изменений ${changes.length}.`,finishedAt);
  writePrivateJson(output,report);
  console.log(JSON.stringify({...report,price_changes_count:changes.length,price_changes:undefined}));
}catch(error){
  const report={status:controller.signal.aborted?'interrupted':'error',started_at:startedAt,finished_at:new Date().toISOString(),check_id:check,
    code:error.code||'incomplete_refresh',failures,requests:requests.length,previous_prices_preserved:!committed,prices_saved:committed};
  if(db&&error.retry_after_ms>0)db.updateState({not_before:new Date(Date.now()+error.retry_after_ms).toISOString()});
  if(db&&check)db.finish(check,report.status,committed?'Цены сохранены, но итоговый отчёт не завершён.':'Разовая проверка не завершена; прежние цены сохранены.',report.finished_at);
  writePrivateJson(output,report);console.log(JSON.stringify(report));process.exitCode=1;
}finally{await client?.close();db?.close();await release?.();}
