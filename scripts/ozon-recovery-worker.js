import {spawn} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createBrowserReader} from '../src/providers/ozon/browser-refresh.js';
import {RECOVERY_LIMIT} from '../src/providers/ozon/recovery.js';
import {validateCapturedRequest} from '../src/providers/ozon/network-capture.js';

// Socket-activated by systemd as ozonbrowser, never run by the web process as root.
let display, chrome, closing = false;
const stopped = child => child ? new Promise(resolve => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => child.kill('SIGKILL'),2000);
  child.once('exit', () => {clearTimeout(timer);resolve();}); child.kill('SIGTERM');
}) : Promise.resolve();
async function cleanup() {closing = true; await stopped(chrome); await stopped(display);}
const timeout = setTimeout(() => {cleanup().finally(() => process.exit(1));},590000);
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
    if (inputBytes > 16384) cleanup().finally(() => process.exit(1));
    if (chunk.includes(10)) inputBytes = chunk.length-chunk.lastIndexOf(10)-1;
  });
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw Error('No request');
  let input = JSON.parse(first.value);
  if (input.version !== 2 || input.id !== 1) throw Error('Invalid version');
  const request = validateCapturedRequest(input.request);
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
  const browser = await createBrowserReader(call,request);
  let expected = 1;
  while (true) {
    if (input.version !== 2 || input.id !== expected++) throw Error('Invalid sequence');
    let result;
    if (input.close === true) {
      try {await call('Browser.close');} catch { /* Chrome may close the pipe before replying. */ }
      await cleanup();result = {version:2,browser_closed:true};
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
