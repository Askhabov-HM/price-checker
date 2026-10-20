import {spawn} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createBrowserReader,browserCookieParams,browserCookieSeed} from '../src/providers/ozon/browser-refresh.js';
import {RECOVERY_LIMIT} from '../src/providers/ozon/recovery.js';
import {validateCapturedRequest} from '../src/providers/ozon/network-capture.js';
import {createBrowserView} from '../src/providers/ozon/browser-view.js';
import {createHash} from 'node:crypto';
import {pathMatch} from 'tough-cookie';
import {ozonBrowserProxyArgs} from '../src/providers/ozon/proxy-config.js';
import {ozonBrowserOptions} from '../src/providers/ozon/browser-options.js';
import {browserFailureStore,captureOpenBrowserSnapshot} from '../src/providers/ozon/browser-monitor.js';

// Socket-activated by systemd as ozonbrowser, never run by the web process as root.
let display, chrome, view, closing = false;
const persistent = process.argv.includes('--persistent');
const helpers = [];
const stopped = child => child ? new Promise(resolve => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => child.kill('SIGKILL'),2000);
  child.once('exit', () => {clearTimeout(timer);resolve();}); child.kill('SIGTERM');
}) : Promise.resolve();
let cleanupPromise;
function cleanup() {return cleanupPromise ??= (async () => {
  closing = true;
  for (const child of helpers.toReversed()) await stopped(child);
  view?.remove();view = null;
  await stopped(chrome);await stopped(display);
})();}
let timeout = persistent ? null : setTimeout(() => {cleanup().finally(() => process.exit(1));},590000);
process.on('SIGTERM', () => cleanup().finally(() => process.exit(1)));
process.stdin.on('end', () => {if (!closing) cleanup().finally(() => process.exit(1));});
process.stdin.on('error', () => cleanup().finally(() => process.exit(1)));
process.stdout.on('error', () => cleanup().finally(() => process.exit(1)));

try {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('Wrong worker user');
  const profile = process.env.OZON_BROWSER_PROFILE;
  if (!profile || realpathSync(profile) !== profile || !profile.startsWith('/var/lib/price-checker-ozon-browser/')
    || !statSync(profile).isDirectory() || statSync(profile).uid !== process.getuid()) throw Error('Invalid profile');
  const failureStore = browserFailureStore(profile),startedAt = new Date().toISOString();
  let inputBytes = 0;
  process.stdin.on('data',chunk => {
    inputBytes += chunk.length;
    if (inputBytes > 262144) cleanup().finally(() => process.exit(1));
    if (chunk.includes(10)) inputBytes = chunk.length-chunk.lastIndexOf(10)-1;
  });
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw Error('No request');
  let input = JSON.parse(first.value);
  if (input.version !== 2 || input.id !== 1) throw Error('Invalid version');
  const login = input.login === 'start';
  const warmup = input.warmup === true;
  if (input.warmup !== undefined && (!persistent || !warmup || login)) throw Error('Invalid warmup');
  if (persistent && login) throw Error('Interactive login needs a separate browser');
  if (login) {clearTimeout(timeout);timeout = setTimeout(() => {cleanup().finally(() => process.exit(1));},21*60000);}
  if (input.login && !login) throw Error('Invalid login action');
  const phone = login ? input.phone : null;
  if (login && !/^\+7\d{10}$/.test(phone || '')) throw Error('Invalid phone');
  browserCookieParams(input.cookies || []);
  const request = validateCapturedRequest(warmup ? {method:'GET',headers:{},
    url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fmy%2Ffavorites%3Fsorting%3Dlast_added'} : input.request);
  if (login && request.operation !== 'favorites') throw Error('Invalid login target');
  if (!['product','favorites','cart'].includes(request.operation)) throw Error('Invalid target');
  const options = ozonBrowserOptions();
  display = spawn('/usr/bin/Xvfb',['-displayfd','3','-screen','0',options.screen,'-nolisten','tcp'],{stdio:['ignore','ignore','ignore','pipe']});
  display.once('exit',() => {if (persistent && !closing) void cleanup().finally(() => process.exit(1));});
  const number = await new Promise((resolve,reject) => {
    let text = '';
    display.on('error',reject); display.once('exit',() => reject(Error('Display failed')));
    display.stdio[3].on('data',chunk => {text += chunk; if (/^\d+\n$/.test(text)) resolve(text.trim()); else if(text.length > 10) reject(Error('Display failed'));});
  });
  chrome = spawn('/opt/google/chrome/chrome',[
    ...ozonBrowserProxyArgs(),
    ...options.chromeArgs,
    '--user-data-dir='+profile,'--remote-debugging-pipe',
    '--no-first-run','--no-default-browser-check','about:blank',
  ],{env:{...process.env,DISPLAY:':'+number},stdio:['ignore','ignore','ignore','pipe','pipe']});
  let sequence = 0, buffer = Buffer.alloc(0); const pending = new Map();
  const fail = () => {for (const item of pending.values()) {clearTimeout(item.timer);item.reject(Error('Browser closed'));}pending.clear();};
  chrome.on('error',fail);chrome.on('exit',() => {
    fail();if (persistent && !closing) void cleanup().finally(() => process.exit(1));
  });chrome.stdio[3].on('error',fail);chrome.stdio[4].on('error',fail);
  chrome.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    if (buffer.length > RECOVERY_LIMIT) {fail();chrome.kill('SIGKILL');return;}
    let index;
    while ((index = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0,index); buffer = buffer.subarray(index+1);
      try {
        const message = JSON.parse(frame.toString('utf8')), item = pending.get(message.id);
        if (item) {pending.delete(message.id);clearTimeout(item.timer);message.error ? item.reject(Error('CDP failed')) : item.resolve(message.result);}
      } catch {fail();}
    }
  });
  const call = (method,params = {},sessionId) => new Promise((resolve,reject) => {
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id);reject(Error('CDP timed out'));},18000);
    pending.set(id,{resolve,reject,timer});
    chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})+'\0');
  });
  let browser;
  const initialize = async (captured,seed = []) => {
    if (browser) return browser;
    const saved = await call('Storage.getCookies');
    const cookies = browserCookieSeed(seed,saved.cookies);
    if (cookies.length) await call('Storage.setCookies',{cookies});
    return browser = await createBrowserReader(call,captured,{interactiveLogin:login,
      ...(persistent ? {onFailure:snapshot => failureStore.save({at:new Date().toISOString(),outcome:'browser_error',http_status:null,snapshot})} : {})});
  };
  if (!warmup) await initialize(request,input.cookies || []);
  if (login) view = await createBrowserView(number,(file,args,options = {}) => {
    const child = spawn(file,args,{stdio:'ignore',...options});helpers.push(child);
    child.on('error',() => cleanup().finally(() => process.exit(1)));
    return child;
  });
  let expected = 1;
  const exportCookies = async () => {
    const {cookies} = await call('Storage.getCookies');
    return cookies.filter(cookie => ['.ozon.ru','ozon.ru','www.ozon.ru'].includes(cookie.domain)
      && pathMatch(new URL(request.url).pathname,cookie.path));
  };
  while (true) {
    if (input.version !== 2 || input.id !== expected++) throw Error('Invalid sequence');
    let result;
    if (input.close === true) {
      closing = true;
      try {await call('Browser.close');} catch { /* Chrome may close the pipe before replying. */ }
      await cleanup();result = {version:2,browser_closed:true};
    } else if (persistent && input.release === true) {
      browser?.reset();result = {version:2,released:true};
    } else if (persistent && input.warmup === true && input.id === 1) {
      await call('Browser.getVersion');result = {version:2,ready:true};
    } else if (persistent && input.inspect === true) {
      const snapshot = browser ? await browser.snapshot() : await captureOpenBrowserSnapshot(call);
      result = {version:2,running:chrome.exitCode === null,started_at:startedAt,
        mode:snapshot ? snapshot.url === 'about:blank' ? 'blank' : 'idle' : 'unresponsive',snapshot};
    } else if (login) {
      if (input.login === 'start' && input.id === 1) result = {version:2,view:{port:view.port,password:view.password}};
      else if (input.login === 'state') {
        const cookies = await exportCookies();
        const identity = cookies.filter(cookie => ['__Secure-access-token','__Secure-refresh-token','__Secure-user-id'].includes(cookie.name))
          .map(cookie => [cookie.domain,cookie.path,cookie.name,cookie.value,cookie.expires])
          .sort((left,right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        result = {version:2,signature:createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
          has_auth:cookies.some(cookie => cookie.name === '__Secure-access-token' && cookie.value && (cookie.session || cookie.expires*1000 > Date.now()))};
      }
      else if (input.login === 'phone') {
        const {targetInfos} = await call('Target.getTargets');
        const target = targetInfos.find(target => target.type === 'page' && target.url.startsWith('https://www.ozon.ru/'));
        if (!target) throw Error('Login page unavailable');
        const {sessionId} = await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        try {
          const filled = await call('Runtime.evaluate',{expression:`(()=>{
            if(location.origin!=="https://www.ozon.ru")return false;
            const field=[...document.querySelectorAll('input[type="tel"],input[autocomplete="tel"],input[name="phone"]')]
              .find(el=>el.getClientRects().length && el.autocomplete!=="one-time-code" && (el.maxLength<0 || el.maxLength>=10));
            if(!field)return false;
            const phone=${JSON.stringify(phone)};
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,field.maxLength===10?phone.slice(2):phone);
            field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));return true;
          })()`,returnByValue:true},sessionId);
          result = {version:2,filled:filled.result?.value === true};
        } finally {await call('Target.detachFromTarget',{sessionId});}
      } else if (input.login === 'finish') {
        result = await browser.read(request);
        if (result.data?.userInfo?.user?.isLoggedIn === true) {
          result.exported = {cookies:await exportCookies()};
        }
      } else throw Error('Invalid login action');
    } else {
      await initialize(input.request,input.cookies || []);
      try {result = await browser.read(input.request);}
      catch (error) {
        if (persistent) failureStore.save({at:new Date().toISOString(),outcome:'browser_error',http_status:null,snapshot:await browser.snapshot()});
        throw error;
      }
      if (persistent && (result.http_status !== 200 || result.outcome !== 'json_received' || result.data?.userInfo?.user?.isLoggedIn === false)) {
        failureStore.save({at:new Date().toISOString(),outcome:result.data?.userInfo?.user?.isLoggedIn === false ? 'login_required' : result.outcome,
          http_status:result.http_status,snapshot:await browser.snapshot()});
      }
      if (persistent && result.http_status === 200 && result.outcome === 'json_received') result.exported = {cookies:await exportCookies()};
    }
    const output = JSON.stringify({...result,id:input.id})+'\n';
    if (Buffer.byteLength(output) > RECOVERY_LIMIT) throw Error('Too large');
    await new Promise((resolve,reject) => process.stdout.write(output,error => error ? reject(error) : resolve()));
    if (closing) break;
    const next = await lines.next();
    if (next.done || Buffer.byteLength(next.value) > (browser ? 16384 : 262144)) break;
    input = JSON.parse(next.value);
  }
} catch {
  await cleanup();
} finally {await cleanup();clearTimeout(timeout);process.stdin.destroy();}
