import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OzonService} from '../src/providers/ozon/service.js';

let service;
try {
  const [url] = process.argv.slice(2);
  if (!url || process.argv.length !== 3) throw Error('arguments');
  service = new OzonService(dirname(dirname(fileURLToPath(import.meta.url))));
  const id = service.watch(url);
  await service.start({id,trigger:'cli'});
  await service.running;
  const check = service.status().checks[0], detail = service.db.detail(id,0);
  console.log(JSON.stringify({success:check?.status === 'success',checked_products:check?.completed || 0,
    schedule_enabled:service.status().schedule_enabled,observations:detail.points.length,
    regular_price_present:detail.product.regular_kopecks > 0,ozon_card_price_present:detail.product.ozon_card_kopecks > 0,
    seller_present:Boolean(detail.product.seller_id),message:check?.message}));
  if (check?.status !== 'success') process.exitCode = 1;
} catch {console.error('Проверка товара Ozon не выполнена. Проверьте подключение и паузу источника.'); process.exitCode = 1;}
finally {await service?.close();}
