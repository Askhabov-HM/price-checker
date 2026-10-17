import {readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireInstance, AlreadyRunning} from '../src/instance.js';
import {ValidationError} from '../src/errors.js';
import {OzonProbeStore, ozonProbePaths} from '../src/providers/ozon/probe-store.js';
import {loadCapturedRequest} from '../src/providers/ozon/network-capture.js';
import {OzonSession, writePrivateJson} from '../src/providers/ozon/session.js';
import {requestOzonJson} from '../src/providers/ozon/json-client.js';
import {verifyAccountResponse} from '../src/providers/ozon/account-check.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, '.secrets/ozon-server');
const mode = process.argv[2] || '--status';
let release, store;
try {
  if (process.argv.length > 3 || !['--status', '--once', '--help'].includes(mode)) throw new ValidationError('Используйте --status, --once или --help.');
  if (mode === '--help') {
    console.log('Проверка серверного доступа Ozon: --status без сети; --once одно чтение избранного с проверкой аккаунта и доставки.\nТребуются приватные .secrets/ozon-server/{requests,reference}.json. Пауза общая с диагностикой Ozon.');
  } else {
    const paths = ozonProbePaths(root);
    release = await acquireInstance(paths.lock);
    store = new OzonProbeStore(paths.database);
    const state = store.status();
    if (mode === '--status' || !state.allowed) {
      console.log(JSON.stringify({state, network_requests_made: 0}, null, 2));
      if (mode === '--once') process.exitCode = 1;
    } else {
      const captured = loadCapturedRequest(join(directory, 'requests.json'), 'favorites');
      const referencePath = join(directory, 'reference.json');
      if (statSync(referencePath).size > 4096) throw new ValidationError('Некорректный эталон аккаунта Ozon.');
      const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
      if (!/^[1-9]\d{0,19}$/.test(reference.account_id) || !/^[a-f0-9]{64}$/.test(reference.delivery_digest)) {
        throw new ValidationError('Некорректный эталон аккаунта Ozon.');
      }
      const session = await OzonSession.open(join(directory, 'session.json'), captured.headers.cookie);
      await session.save();
      store.beginAttempt();
      const result = await requestOzonJson(captured, {session});
      const report = verifyAccountResponse(result, reference);
      const updated = store.record(report.summary);
      writePrivateJson(join(directory, 'last-report.json'), report);
      console.log(JSON.stringify({...report, state: updated}, null, 2));
      if (!report.success) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof ValidationError ? error.message : error instanceof AlreadyRunning ? 'Проверка Ozon уже выполняется.'
    : 'Проверка Ozon остановлена. Приватные данные не выведены.');
  process.exitCode = 1;
} finally {store?.close(); await release?.();}
