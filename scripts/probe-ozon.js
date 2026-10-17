import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireInstance, AlreadyRunning} from '../src/instance.js';
import {ValidationError} from '../src/errors.js';
import {probeTarget} from '../src/providers/ozon/url.js';
import {probeOzon} from '../src/providers/ozon/probe.js';
import {OzonProbeStore, ozonProbePaths} from '../src/providers/ozon/probe-store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Диагностика Ozon без входа в аккаунт и без изменения Randewoo.
  npm run ozon:probe                         один публичный GET главной страницы
  npm run ozon:probe -- https://www.ozon.ru/product/…
  npm run ozon:status                        локальный статус, без запросов к Ozon
  npm run ozon:probe -- --acknowledge-pause   подтвердить проверку причины паузы; без сетевых запросов
Повторные проверки используют отдельную базу .data/ozon/probe.sqlite3 и учитывают паузу 2 часа.
Перенаправления, ограничения доступа и CAPTCHA не обходятся. HTML и сессии не сохраняются.`;

let store, release;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(help);
  else {
    if (args.length > 1 || args[0]?.startsWith('--') && !['--status', '--acknowledge-pause'].includes(args[0])) throw new ValidationError('Некорректные аргументы. Используйте --help.');
    const statusOnly = args[0] === '--status', acknowledge = args[0] === '--acknowledge-pause';
    const url = statusOnly || acknowledge ? undefined : args[0];
    probeTarget(url); // Validate before creating files or taking a lock.
    const paths = ozonProbePaths(root);
    if (statusOnly && !existsSync(paths.database)) {
      console.log(JSON.stringify({provider: 'ozon', scope: 'transport_probe', initialized: false, city: 'Грозный',
        interval_minutes: 120, account_connected: false, collector_enabled: false}, null, 2));
    } else {
      release = await acquireInstance(paths.lock);
      store = new OzonProbeStore(paths.database);
      if (statusOnly) console.log(JSON.stringify(store.status(), null, 2));
      else if (acknowledge) console.log(JSON.stringify(store.acknowledge(), null, 2));
      else {
        store.assertAllowed();
        store.beginAttempt();
        const result = await probeOzon(url);
        const state = store.record(result);
        console.log(JSON.stringify({probe: result, state}, null, 2));
        if (result.outcome !== 'html_received') process.exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(error instanceof ValidationError ? error.message : error instanceof AlreadyRunning ? 'Диагностика Ozon уже запущена.' : 'Диагностика Ozon не выполнена. Проверьте доступ к отдельной базе и зависимости.');
  process.exitCode = 1;
} finally {store?.close(); await release?.();}
