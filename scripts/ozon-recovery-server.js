import {PersistentBrowserPool} from '../src/providers/ozon/browser-pool.js';
import {launchBrowserWorker} from '../src/providers/ozon/worker-channel.js';
import {createRecoveryServer} from '../src/providers/ozon/recovery-server.js';
import {browserFailureStore} from '../src/providers/ozon/browser-monitor.js';
import {chmodSync,chownSync,rmSync,statSync} from 'node:fs';
import {BROWSER_MONITOR_SOCKET,RECOVERY_SOCKET} from '../src/providers/ozon/recovery.js';

if (process.platform !== 'linux' || process.getuid() === 0
  || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') throw Error('Run through the Ozon recovery socket');
const pool = new PersistentBrowserPool({launch:launchBrowserWorker});
const failureStore=browserFailureStore(process.env.OZON_BROWSER_PROFILE);
const service = createRecoveryServer(pool,{readLastError:() => failureStore.read()});
const monitor = createRecoveryServer(pool,{readLastError:() => failureStore.read(),monitorOnly:true,closePool:false});
const maintain = () => {void pool.ensureWarm().catch(() => {});};
const maintenance = setInterval(maintain,30000);maintenance.unref();
let stopping;
const stop = code => {
  clearInterval(maintenance);
  return stopping ??= Promise.all([monitor.close(),service.close()]).then(() => process.exit(code));
};
process.on('SIGTERM',() => {void stop(0);});
process.on('SIGINT',() => {void stop(0);});
service.server.on('error',() => {void stop(1);});
monitor.server.on('error',() => {void stop(1);});
service.server.once('listening',maintain);
service.server.listen({fd:3});
// This socket exists only while the service is running; viewing cannot socket-activate Chrome.
rmSync(BROWSER_MONITOR_SOCKET,{force:true});
monitor.server.listen(BROWSER_MONITOR_SOCKET,() => {
  chownSync(BROWSER_MONITOR_SOCKET,process.getuid(),statSync(RECOVERY_SOCKET).gid);
  chmodSync(BROWSER_MONITOR_SOCKET,0o660);
});
