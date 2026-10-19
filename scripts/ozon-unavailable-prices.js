import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {OzonClient} from '../src/providers/ozon/client.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';
import {readUnavailablePrice} from '../src/providers/ozon/unavailable-price.js';
import {writePrivateJson} from '../src/providers/ozon/session.js';
import {acquireInstance} from '../src/instance.js';

const root='/opt/price-checker/current';
let db,release,check,client,stopping=false;
const controller=new AbortController();
process.once('SIGTERM',()=>{stopping=true;controller.abort();});
process.once('SIGINT',()=>{stopping=true;controller.abort();});
const results=[],requests=[];
const report=()=>({checked:results.length,updated:results.filter(r=>r.price).length,
  without_price:results.filter(r=>r.outcome==='no_price').length,errors:results.filter(r=>r.outcome==='error').length,
  requests:requests.length,statuses:requests.reduce((counts,r)=>(counts[r.status]=(counts[r.status]||0)+1,counts),{}),
  results});
try {
  release=await acquireInstance(join(root,'.data/ozon/collector.lock'));
  db=new OzonDatabase(root);
  let targets=db.db.prepare(`SELECT p.sku,p.url,p.title FROM membership m JOIN products p ON p.sku=m.sku
    JOIN observations o ON o.id=(SELECT MAX(z.id) FROM observations z WHERE z.sku=p.sku AND z.status='ok')
    WHERE m.list='favorites' AND o.availability IN ('out_of_stock','unavailable') ORDER BY m.position`).all();
  if(process.argv.includes('--retry-errors')) {
    const previous=JSON.parse(readFileSync(join(root,'.secrets/ozon/unavailable-price-update.json'),'utf8'));
    const retry=new Set(previous.results.filter(r=>r.outcome==='error').map(r=>r.sku));
    targets=targets.filter(product=>retry.has(product.sku));
  }
  client=new OzonClient(root);await client.open(controller.signal);
  check=db.begin('manual',new Date().toISOString());db.progress(check,targets.length);
  const insert=db.db.prepare(`INSERT INTO observations(check_id,sku,checked_at,status,availability,listed_price_kopecks,original_price_kopecks,message,source)
    VALUES(?,?,?,'ok',?,?,?,?,'http')`);
  for(const [index,product]of targets.entries()) {
    if(stopping)throw Error('Interrupted');
    if(index)await pause(500,undefined,{signal:controller.signal});
    try {
      const response=await readUnavailablePrice(client,product,{trace:requests,signal:controller.signal});
      const now=new Date().toISOString();
      if(response.price) {
        const price=response.price;
        db.transaction(()=>{
          insert.run(check,product.sku,now,price.availability,price.listed_price_kopecks,price.original_price_kopecks,'Цена из '+price.field+'; доступность сохранена отдельно.');
          db.db.prepare('UPDATE checks SET completed=completed+1 WHERE id=?').run(check);
        });
        results.push({sku:product.sku,title:product.title,outcome:'saved',price});
      }else{
        db.failure(check,product.sku,'Ответ Ozon не содержит подтверждённой цены этого товара.',now,'http');
        results.push({sku:product.sku,title:product.title,outcome:'no_price'});
        writePrivateJson(join(root,'.secrets/ozon/unavailable-price-responses',product.sku+'.json'),response.data);
      }
    }catch(error){
      const code=error.code||'network_error';
      db.failure(check,product.sku,'Цена недоступного товара не получена: '+code,new Date().toISOString(),'http');
      results.push({sku:product.sku,title:product.title,outcome:'error',code});
      if(error.retry_after_ms>0 || ['login_required','context_mismatch','rate_limited','access_limited'].includes(code))throw error;
    }
    writePrivateJson(join(root,'.secrets/ozon/unavailable-price-update.json'),{check_id:check,total:targets.length,...report()});
    if((index+1)%10===0)console.log(JSON.stringify({progress:index+1,total:targets.length,updated:results.filter(r=>r.price).length}));
  }
  const summary=report(),status=summary.updated===targets.length?'success':'partial';
  db.finish(check,status,`Цены недоступных товаров: получено ${summary.updated} из ${targets.length}.`,new Date().toISOString());
  writePrivateJson(join(root,'.secrets/ozon/unavailable-price-update.json'),{check_id:check,total:targets.length,status,...summary});
  console.log(JSON.stringify({check_id:check,total:targets.length,status,...summary,results:undefined,
    missing:results.filter(r=>!r.price),book:results.find(r=>r.sku==='721295408')}));
}catch(error){
  if(db&&check)db.finish(check,stopping?'interrupted':'partial','Обновление недоступных товаров остановлено: '+(error.code||'interrupted'),new Date().toISOString());
  if(check)writePrivateJson(join(root,'.secrets/ozon/unavailable-price-update.json'),{check_id:check,stopped:true,code:error.code||'interrupted',...report()});
  console.log(JSON.stringify({stopped:true,code:error.code||'interrupted',...report(),results:undefined}));process.exitCode=1;
}finally{await client?.close();db?.close();await release?.();}
