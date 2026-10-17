import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireInstance, AlreadyRunning} from '../src/instance.js';
import {ValidationError} from '../src/errors.js';
import {readHar, saveCapturedRequests, loadCapturedRequest, jsonShape} from '../src/providers/ozon/network-capture.js';
import {requestOzonJson} from '../src/providers/ozon/json-client.js';
import {OzonSession} from '../src/providers/ozon/session.js';
import {OzonProbeStore, ozonProbePaths} from '../src/providers/ozon/probe-store.js';
import {readSnapshot} from '../src/providers/ozon/snapshot.js';

const root = dirname(dirname(fileURLToPath(import.meta.url))), privatePath = join(root, '.secrets/ozon-requests.json');
const args = process.argv.slice(2);
let store, release;
try {
  const mode = args[0] || '--inspect';
  if (['--help', '-h'].includes(mode)) {
    console.log(`Ozon Network: разбор сохранённых ответов и отдельная диагностика HTTP.
  npm run ozon:network -- --preview [capture.json]  снимок Chrome DevTools MCP, без сети
  npm run ozon:network -- --inspect [путь.har]  анализ локального HAR, без сети
  npm run ozon:network -- --import [путь.har]   сохранить запросы приватно, без сети
  npm run ozon:network -- --probe cart         одно чтение корзины (до двух проверенных переходов)
  npm run ozon:network -- --probe favorites    одно чтение избранного (до двух проверенных переходов)
Снимок по умолчанию: .secrets/ozon-mcp/capture.json.
HAR по умолчанию: .secrets/ozon-network.har. Сессии не выводятся и не передаются на другие сайты.`);
  } else if (mode === '--preview' && args.length <= 2) {
    const snapshot = readSnapshot(resolve(args[1] || join(root, '.secrets/ozon-mcp/capture.json')));
    console.log(JSON.stringify({provider: snapshot.provider, source: snapshot.source, live: snapshot.live, network_requests_made: 0,
      favorites: {count: snapshot.favorites.items.length, limit: snapshot.favorites.limit, complete: snapshot.favorites.complete},
      cart: snapshot.cart ? {count: snapshot.cart.items.length, complete: snapshot.cart.complete} : null,
      product: snapshot.product}, null, 2));
  } else if (['--inspect', '--import'].includes(mode) && args.length <= 2) {
    const capture = readHar(resolve(args[1] || join(root, '.secrets/ozon-network.har')));
    const result = {...capture.summary, network_requests_made: 0};
    if (mode === '--import') result.saved_operations = saveCapturedRequests(privatePath, capture);
    console.log(JSON.stringify(result, null, 2));
  } else if (mode === '--probe' && args.length === 2 && ['cart', 'favorites'].includes(args[1])) {
    const captured = loadCapturedRequest(privatePath, args[1]);
    const paths = ozonProbePaths(root);
    release = await acquireInstance(paths.lock);
    store = new OzonProbeStore(paths.database);
    store.assertAllowed();
    const session = await OzonSession.open(join(root, '.secrets/ozon-http-session.json'), captured.headers.cookie);
    await session.save();
    store.beginAttempt();
    const {summary, data} = await requestOzonJson(captured, {session});
    const state = store.record(summary);
    console.log(JSON.stringify({probe: summary, ...(data ? {shape: jsonShape(data)} : {}), state}, null, 2));
    if (summary.outcome !== 'json_received') process.exitCode = 1;
  } else throw new ValidationError('Некорректные аргументы. Используйте npm run ozon:network -- --help.');
} catch (error) {
  console.error(error instanceof ValidationError ? error.message : error instanceof AlreadyRunning ? 'Диагностика Ozon уже запущена.'
    : error.code === 'ENOENT' ? 'Локальный файл Network не найден. Проверьте путь к снимку или HAR.' : 'Не удалось обработать Network Ozon. Приватные данные не выведены.');
  process.exitCode = 1;
} finally {store?.close(); await release?.();}
