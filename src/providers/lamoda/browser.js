import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync,realpathSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer,connect} from 'node:net';
import {LamodaError,parseWishlistHtml,readAllFavorites} from './parser.js';

const origin = 'https://www.lamoda.ru';
export function wishlistExpression(page) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new LamodaError('invalid_data');
  // Only this fixed, read-only same-origin GET can be requested over the socket.
  return `(async()=>{if(location.origin!==${JSON.stringify(origin)})return {unverified:true};
    const r=await fetch('/wishlist/?page=${page}',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
    if(!r.ok)return {status:r.status,retry:r.headers.get('Retry-After')};
    if(!r.headers.get('content-type')?.includes('text/html'))return {unverified:true};
    const reader=r.body.getReader();let size=0,text='';const decoder=new TextDecoder();
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
      if(size>12582912){await reader.cancel();return {unverified:true};}text+=decoder.decode(part.value,{stream:true});}
    return {status:r.status,html:text+decoder.decode()};})()`;
}
export function retryAfter(value,now = Date.now()) {
  if (!value) return 0;
  return Math.min(365*86400000,/^\d+$/.test(value) ? Number(value)*1000 : Math.max(0,Date.parse(value)-now)||0);
}
const stopped = child => !child?.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => {
  const timer = setTimeout(() => child.kill('SIGKILL'),3000);child.once('exit',() => {clearTimeout(timer);resolve();});child.kill('SIGTERM');
});
async function unusedPort() {
  const server = createServer();await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
async function ready(port,child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new LamodaError('browser_unavailable');
    const ok = await new Promise(resolve => {
      const socket = connect({host:'127.0.0.1',port});const end = value => {socket.destroy();resolve(value);};
      socket.setTimeout(200);socket.once('connect',() => end(true));socket.once('error',() => end(false));socket.once('timeout',() => end(false));
    });
    if (ok) return;await delay(100);
  }
  throw new LamodaError('browser_unavailable');
}
export class LamodaBrowser {
  constructor({profile = process.env.LAMODA_BROWSER_PROFILE,chrome = '/opt/google/chrome/chrome',call} = {}) {
    this.profile = profile;this.chromePath = chrome;this.injectedCall = call;this.children = [];this.pending = new Map();this.sequence = 0;
  }
  launch(command,args,options = {}) {
    const child = spawn(command,args,{stdio:['ignore','ignore','ignore'],...options});this.children.push(child);return child;
  }
  async ensure() {
    if (this.injectedCall) {this.call = this.injectedCall;return;}
    if (this.chrome?.exitCode === null && this.chrome?.signalCode === null && this.session) return;
    await this.close();
    if (process.platform !== 'linux' || process.getuid() === 0 || !this.profile
      || !this.profile.startsWith('/var/lib/price-checker-lamoda-browser/') || realpathSync(this.profile) !== this.profile
      || !statSync(this.profile).isDirectory() || statSync(this.profile).uid !== process.getuid()) throw new LamodaError('browser_unavailable');
    this.display = this.launch('/usr/bin/Xvfb',['-displayfd','3','-screen','0','1600x1000x24','-nolisten','tcp'],{stdio:['ignore','ignore','ignore','pipe']});
    const display = await new Promise((resolve,reject) => {
      let value = '';const timer = setTimeout(() => reject(new LamodaError('browser_unavailable')),10000);
      this.display.once('error',reject);this.display.once('exit',() => reject(new LamodaError('browser_unavailable')));
      this.display.stdio[3].on('data',chunk => {value+=chunk;if (/^\d+\n$/.test(value)) {clearTimeout(timer);resolve(value.trim());}});
    });
    this.displayNumber = display;
    this.chrome = this.launch(this.chromePath,['--user-data-dir='+this.profile,'--remote-debugging-pipe','--lang=ru',
      '--window-size=1280,900','--no-first-run','--no-default-browser-check','about:blank'],
    {env:{...process.env,DISPLAY:':'+display},stdio:['ignore','ignore','ignore','pipe','pipe']});
    let buffer = Buffer.alloc(0);
    const fail = () => {for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(new LamodaError('browser_unavailable'));}this.pending.clear();};
    this.chrome.on('error',fail);this.chrome.on('exit',fail);this.chrome.stdio[3].on('error',fail);this.chrome.stdio[4].on('error',fail);
    this.chrome.stdio[4].on('data',chunk => {
      buffer = Buffer.concat([buffer,chunk]);if (buffer.length > 32*1024*1024) {fail();this.chrome.kill('SIGKILL');return;}
      let end;
      while ((end = buffer.indexOf(0)) !== -1) {
        const frame = buffer.subarray(0,end);buffer = buffer.subarray(end+1);
        try {const message = JSON.parse(frame.toString('utf8')),pending = this.pending.get(message.id);
          if (pending) {this.pending.delete(message.id);clearTimeout(pending.timer);message.error ? pending.reject(new LamodaError('browser_unavailable')) : pending.resolve(message.result);}
        } catch {fail();}
      }
    });
    this.call = (method,params = {},sessionId) => new Promise((resolve,reject) => {
      const id = ++this.sequence,timer = setTimeout(() => {this.pending.delete(id);reject(new LamodaError('browser_unavailable'));},55000);
      this.pending.set(id,{resolve,reject,timer});this.chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})+'\0');
    });
    let target;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await this.call('Target.getTargets');target = result.targetInfos?.find(info => info.type === 'page' && info.url === 'about:blank');
      if (target) break;await delay(250);
    }
    if (!target) throw new LamodaError('browser_unavailable');
    this.session = (await this.call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    // Restore only missing/expired cookies before the site's first navigation;
    // a guest page must not replace the saved authorization during bootstrap.
    await this.seedCookies();
    await this.call('Page.navigate',{url:origin+'/wishlist/'},this.session);
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await this.call('Runtime.evaluate',{expression:'({origin:location.origin,ready:document.readyState})',returnByValue:true},this.session);
      if (result.result?.value?.origin === origin && result.result.value.ready !== 'loading') return;
      await delay(250);
    }
    throw new LamodaError('browser_unavailable');
  }
  async seedCookies() {
    const path = join(this.profile,'price-checker-session.json');if (!existsSync(path) || statSync(path).size > 1024*1024) return;
    let cookies;try {cookies = JSON.parse(readFileSync(path,'utf8'));} catch {return;}
    const current = (await this.call('Storage.getCookies')).cookies || [];
    const identity = c => JSON.stringify([c.name,c.domain,c.path,c.partitionKey || null]);
    const existing = new Set(current.filter(c => c.expires === -1 || c.expires*1000 > Date.now()).map(identity));
    const missing = Array.isArray(cookies) ? cookies.filter(cookie => this.validCookie(cookie) && !existing.has(identity(cookie))) : [];
    if (missing.length) await this.call('Storage.setCookies',{cookies:missing});
  }
  validCookie(cookie) {
    return cookie && ['lamoda.ru','.lamoda.ru','www.lamoda.ru'].includes(cookie.domain) && typeof cookie.name === 'string'
      && typeof cookie.value === 'string' && typeof cookie.path === 'string' && cookie.path.startsWith('/')
      && (cookie.expires === undefined || cookie.expires === -1 || cookie.expires*1000 > Date.now()) && !cookie.partitionKeyOpaque
      && (!cookie.partitionKey || cookie.partitionKey.topLevelSite === 'https://lamoda.ru' && cookie.partitionKey.hasCrossSiteAncestor === false);
  }
  async saveCookies() {
    const cookies = (await this.call('Storage.getCookies')).cookies.filter(cookie => this.validCookie(cookie)).map(cookie => {
      const {name,value,domain,path,secure,httpOnly,sameSite,expires,partitionKey} = cookie;
      return {name,value,domain,path,secure,httpOnly,...(sameSite ? {sameSite} : {}),...(expires > 0 ? {expires} : {}),...(partitionKey ? {partitionKey} : {})};
    });
    const path = join(this.profile,'price-checker-session.json'),temporary = path+'.'+randomBytes(6).toString('hex');
    writeFileSync(temporary,JSON.stringify(cookies),{mode:0o600});renameSync(temporary,path);
  }
  async readPage(page) {
    await this.ensure();
    const response = await this.call('Runtime.evaluate',{expression:wishlistExpression(page),awaitPromise:true,returnByValue:true},this.session);
    const result = response.result?.value;
    if (response.exceptionDetails || !result || result.unverified) throw new LamodaError('account_unverified');
    if (result.status !== 200) throw new LamodaError(result.status === 429 ? 'rate_limited' : 'access_limited',retryAfter(result.retry),result.status);
    return parseWishlistHtml(result.html);
  }
  async collect(signal,expectedDigest) {
    if (this.login) throw new LamodaError('browser_unavailable');
    const result = await readAllFavorites(page => this.readPage(page),{signal});
    if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || createHash('sha256').update('lamoda:'+result.account_id).digest('hex') !== expectedDigest) throw new LamodaError('account_mismatch');
    if (!this.injectedCall) await this.saveCookies();
    return result;
  }
  async startLogin() {
    if (this.login) throw new LamodaError('browser_unavailable');
    await this.ensure();
    const directory = join('/var/lib/price-checker-lamoda-browser','login-'+randomBytes(12).toString('hex'));mkdirSync(directory,{mode:0o700});
    const password = randomBytes(6).toString('base64url'),auth = join(directory,'vnc-auth'),firstChild = this.children.length;
    try {
      await new Promise((resolve,reject) => {const child = this.launch('/usr/bin/x11vnc',['-storepasswd',password,auth]);child.once('error',reject);child.once('exit',code => code === 0 ? resolve() : reject(new LamodaError('browser_unavailable')));});
      const vncPort = await unusedPort();
      const vnc = this.launch('/usr/bin/x11vnc',['-display',':'+this.displayNumber,'-localhost','-rfbport',String(vncPort),'-rfbauth',auth,'-forever','-shared','-noxdamage','-quiet']);await ready(vncPort,vnc);
      const port = await unusedPort();const web = this.launch('/usr/bin/python3',['-m','websockify','127.0.0.1:'+port,'127.0.0.1:'+vncPort],
        {env:{...process.env,PYTHONPATH:process.env.PRICE_CHECKER_REMOTE_PYTHON_PATH || '/opt/price-checker-ozon-remote/extracted/usr/lib/python3/dist-packages'}});await ready(port,web);
      const key = randomBytes(32).toString('hex');this.login = {key,directory,firstChild};
      return {port,password,key};
    } catch(error) {for (const child of this.children.splice(firstChild).reverse()) await stopped(child);rmSync(directory,{recursive:true,force:true});throw error;}
  }
  requireLogin(key) {if (!this.login || key !== this.login.key) throw new LamodaError('browser_unavailable');}
  async verifyLogin(key) {this.requireLogin(key);const result = await this.readPage(1);this.login.account = result.account_id;return {account_id:result.account_id};}
  async endLogin(key,account = null) {
    this.requireLogin(key);
    if (account !== null) {if (account !== this.login.account) throw new LamodaError('account_mismatch');await this.saveCookies();}
    await this.close();await this.ensure();return {closed:true};
  }
  async close() {
    this.session = null;
    for (const child of this.children.splice(0).reverse()) await stopped(child);
    if (this.login) rmSync(this.login.directory,{recursive:true,force:true});this.login = null;this.chrome = null;this.display = null;
  }
}
