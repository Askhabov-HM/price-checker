import {spawn} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createBrowserReader,browserCookieParams} from '../src/providers/ozon/browser-refresh.js';
import {RECOVERY_LIMIT} from '../src/providers/ozon/recovery.js';
import {validateCapturedRequest} from '../src/providers/ozon/network-capture.js';
import {createBrowserView} from '../src/providers/ozon/browser-view.js';

// Socket-activated by systemd as ozonbrowser, never run by the web process as root.
let display, chrome, view, closing = false;
const helpers = [];
const stopped = child => child ? new Promise(resolve => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => child.kill('SIGKILL'),2000);
  child.once('exit', () => {clearTimeout(timer);resolve();}); child.kill('SIGTERM');
}) : Promise.resolve();
async function cleanup() {
  closing = true;
  for (const child of helpers.toReversed()) await stopped(child);
  view?.remove();view = null;
  await stopped(chrome);await stopped(display);
}
let timeout = setTimeout(() => {cleanup().finally(() => process.exit(1));},590000);
process.on('SIGTERM', () => cleanup().finally(() => process.exit(1)));
process.stdin.on('end', () => {if (!closing) cleanup().finally(() => process.exit(1));});
process.stdin.on('error', () => cleanup().finally(() => process.exit(1)));
process.stdout.on('error', () => cleanup().finally(() => process.exit(1)));

try {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('Wrong worker user');
  const profile = process.env.OZON_BROWSER_PROFILE;
  if (!profile || realpathSync(profile) !== profile || !profile.startsWith('/var/lib/price-checker-ozon-browser/')
    || !statSync(profile).isDirectory() || statSync(profile).uid !== process.getuid()) throw Error('Invalid profile');
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
  if (login) {clearTimeout(timeout);timeout = setTimeout(() => {cleanup().finally(() => process.exit(1));},21*60000);}
  if (input.login && !login) throw Error('Invalid login action');
  const phone = login ? input.phone : null;
  if (login && !/^\+7\d{10}$/.test(phone || '')) throw Error('Invalid phone');
  const cookies = browserCookieParams(input.cookies || []);
  const request = validateCapturedRequest(input.request);
  if (login && request.operation !== 'favorites') throw Error('Invalid login target');
  if (!['product','favorites','cart'].includes(request.operation)) throw Error('Invalid target');
  display = spawn('/usr/bin/Xvfb',['-displayfd','3','-screen','0','1365x900x24','-nolisten','tcp'],{stdio:['ignore','ignore','ignore','pipe']});
  const number = await new Promise((resolve,reject) => {
    let text = '';
    display.on('error',reject); display.once('exit',() => reject(Error('Display failed')));
    display.stdio[3].on('data',chunk => {text += chunk; if (/^\d+\n$/.test(text)) resolve(text.trim()); else if(text.length > 10) reject(Error('Display failed'));});
  });
  chrome = spawn('/opt/google/chrome/chrome',[
    '--user-data-dir='+profile,'--remote-debugging-pipe','--lang=ru-RU','--use-gl=angle','--use-angle=swiftshader',
    '--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync',
    '--window-size=1365,900','--window-position=0,0','about:blank',
  ],{env:{...process.env,DISPLAY:':'+number},stdio:['ignore','ignore','ignore','pipe','pipe']});
  let sequence = 0, buffer = Buffer.alloc(0); const pending = new Map();
  const fail = () => {for (const item of pending.values()) {clearTimeout(item.timer);item.reject(Error('Browser closed'));}pending.clear();};
  chrome.on('error',fail);chrome.on('exit',fail);chrome.stdio[3].on('error',fail);chrome.stdio[4].on('error',fail);
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
  if (cookies.length) await call('Storage.setCookies',{cookies});
  const browser = await createBrowserReader(call,request,{interactiveLogin:login});
  if (login) view = await createBrowserView(number,(file,args,options = {}) => {
    const child = spawn(file,args,{stdio:'ignore',...options});helpers.push(child);
    child.on('error',() => cleanup().finally(() => process.exit(1)));
    return child;
  });
  let expected = 1;
  while (true) {
    if (input.version !== 2 || input.id !== expected++) throw Error('Invalid sequence');
    let result;
    if (input.close === true) {
      try {await call('Browser.close');} catch { /* Chrome may close the pipe before replying. */ }
      await cleanup();result = {version:2,browser_closed:true};
    } else if (login) {
      if (input.login === 'start' && input.id === 1) result = {version:2,view:{port:view.port,password:view.password}};
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
          const {cookies} = await call('Storage.getCookies');
          result.exported = {cookies:cookies.filter(cookie => ['.ozon.ru','ozon.ru','www.ozon.ru'].includes(cookie.domain))};
        }
      } else throw Error('Invalid login action');
    } else result = await browser.read(input.request);
    const output = JSON.stringify({...result,id:input.id})+'\n';
    if (Buffer.byteLength(output) > RECOVERY_LIMIT) throw Error('Too large');
    await new Promise((resolve,reject) => process.stdout.write(output,error => error ? reject(error) : resolve()));
    if (closing) break;
    const next = await lines.next();
    if (next.done || Buffer.byteLength(next.value) > 16384) break;
    input = JSON.parse(next.value);
  }
} catch {
  await cleanup();
} finally {await cleanup();clearTimeout(timeout);process.stdin.destroy();}
