import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OzonService} from '../src/providers/ozon/service.js';

let service;
try {
  if (process.argv.length !== 2) throw Error('arguments');
  service = new OzonService(dirname(dirname(fileURLToPath(import.meta.url))));
  await service.start({trigger:'cli'});await service.running;
  const status = service.status(),check = status.checks[0];
  console.log(JSON.stringify({success:check?.status === 'success',checked_products:check?.completed || 0,total_products:check?.total || 0,
    counts:service.db.dashboard('favorites').counts,schedule_enabled:status.schedule_enabled,not_before:status.not_before,
    sources:service.db.db.prepare('SELECT source,COUNT(*) AS count FROM observations WHERE check_id=? AND status=? GROUP BY source').all(check.id,'ok'),message:check?.message}));
  if (check?.status !== 'success') process.exitCode = 1;
} catch {console.error('Не удалось завершить проверку Ozon. Подробности сохранены в состоянии сборщика.');process.exitCode = 1;}
finally {await service?.close();}
