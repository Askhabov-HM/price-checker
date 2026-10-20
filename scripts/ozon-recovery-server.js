import {PersistentBrowserPool} from '../src/providers/ozon/browser-pool.js';
import {launchBrowserWorker} from '../src/providers/ozon/worker-channel.js';
import {createRecoveryServer} from '../src/providers/ozon/recovery-server.js';

if (process.platform !== 'linux' || process.getuid() === 0
  || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') throw Error('Run through the Ozon recovery socket');
const pool = new PersistentBrowserPool({launch:launchBrowserWorker});
const service = createRecoveryServer(pool);
const maintain = () => {void pool.ensureWarm().catch(() => {});};
const maintenance = setInterval(maintain,30000);maintenance.unref();
let stopping;
const stop = code => {
  clearInterval(maintenance);
  return stopping ??= service.close().then(() => process.exit(code));
};
process.on('SIGTERM',() => {void stop(0);});
process.on('SIGINT',() => {void stop(0);});
service.server.on('error',() => {void stop(1);});
service.server.once('listening',maintain);
service.server.listen({fd:3});
