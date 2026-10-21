import {createServer} from 'node:net';
import {chmodSync,existsSync,unlinkSync} from 'node:fs';
import {LamodaBrowser} from '../src/providers/lamoda/browser.js';
import {LamodaError} from '../src/providers/lamoda/parser.js';
import {LAMODA_SOCKET} from '../src/providers/lamoda/channel.js';

const path = process.env.LAMODA_BROWSER_SOCKET || LAMODA_SOCKET;
const browser = new LamodaBrowser();let queue = Promise.resolve(),closing = false,queued = 0,loginTimer;
const enqueue = action => {
  if (queued >= 8 || closing) return Promise.reject(new LamodaError('browser_unavailable'));
  queued++;const work = queue.then(action);queue = work.catch(() => {}).finally(() => {queued--;});return work;
};
if (existsSync(path)) unlinkSync(path);
const server = createServer(socket => {
  let input = Buffer.alloc(0),received = false;const controller = new AbortController();
  socket.on('error',() => controller.abort());socket.once('close',() => controller.abort());socket.setTimeout(590000,() => socket.destroy());
  socket.on('data',chunk => {
    if (received) {socket.destroy();return;}
    input = Buffer.concat([input,chunk]);if (input.length > 4096) {socket.destroy();return;}
    const end = input.indexOf(10);if (end === -1) return;received = true;
    let request;try {request = JSON.parse(input.subarray(0,end).toString('utf8'));} catch {socket.destroy();return;}
    const work = async () => {
      if (controller.signal.aborted || request.version !== 1) throw new LamodaError('interrupted');
      switch (request.action) {
        case 'collect': return browser.collect(controller.signal,request.account_digest);
        case 'login_start': {
          const result = await browser.startLogin();clearTimeout(loginTimer);
          loginTimer = setTimeout(() => {enqueue(() => browser.endLogin(result.key)).catch(() => {});},21*60000);loginTimer.unref();return result;
        }
        case 'login_verify': return browser.verifyLogin(request.key);
        case 'login_finish': clearTimeout(loginTimer);return browser.endLogin(request.key,request.account_id);
        case 'login_cancel': clearTimeout(loginTimer);return browser.endLogin(request.key);
        default: throw new LamodaError('invalid_data');
      }
    };
    enqueue(work).then(data => {if (!socket.destroyed) socket.end(JSON.stringify({version:1,ok:true,data})+'\n');},error => {
      console.error(JSON.stringify({store:'lamoda',event:'browser_error',reason:error instanceof LamodaError ? error.code : 'internal'}));
      if (!socket.destroyed) socket.end(JSON.stringify({version:1,ok:false,code:error instanceof LamodaError ? error.code : 'browser_unavailable',retry_after_ms:error.retry_after_ms || 0,http_status:error.http_status || null})+'\n');
    });
  });
});
server.listen(path,() => {chmodSync(path,0o660);});
server.on('error',() => {console.error(JSON.stringify({store:'lamoda',event:'socket_error'}));shutdown();});
const maintain = () => {if (!queued && !browser.login) enqueue(() => browser.ensure()).catch(() => console.error(JSON.stringify({store:'lamoda',event:'browser_start_error'})));};
const timer = setInterval(maintain,30000);maintain();
async function shutdown() {if (closing) return;closing = true;clearInterval(timer);clearTimeout(loginTimer);server.close();await queue;await browser.close();process.exit(0);}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
