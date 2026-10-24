import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromePath,profilePath} from './chrome-launcher.js';
import {wishlistExpression,retryAfter} from '../../src/providers/lamoda/browser.js';
import {LamodaError,minimalWishlistState,parseWishlistState,readAllFavorites,wishlistStateHtml} from '../../src/providers/lamoda/parser.js';

const wishlistUrl = 'https://www.lamoda.ru/wishlist/';

export async function collectWishlistPages(readPage,expectedDigest,{signal} = {}) {
  const pages = [];
  const result = await readAllFavorites(async number => {
    const {user,payload} = wishlistStateHtml(await readPage(number));
    const state = minimalWishlistState(user,payload);
    pages.push(state);
    return parseWishlistState(state.user,state.payload);
  },{signal});
  const account = createHash('sha256').update('lamoda:'+result.account_id).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || account !== expectedDigest) throw new LamodaError('account_mismatch');
  return {pages,count:result.items.length};
}

export class CdpConnection {
  constructor(socket,{timeout = 55000} = {}) {
    this.socket = socket;this.timeout = timeout;this.sequence = 0;this.pending = new Map();
    socket.addEventListener('message',event => {
      let message;
      try {message = JSON.parse(event.data);} catch {return;}
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);clearTimeout(request.timer);
      if (message.error) request.reject(new LamodaError('browser_unavailable'));
      else request.resolve(message.result);
    });
    const closed = () => {
      for (const request of this.pending.values()) {clearTimeout(request.timer);request.reject(new LamodaError('browser_unavailable'));}
      this.pending.clear();
    };
    socket.addEventListener('close',closed);
    socket.addEventListener('error',closed);
  }
  static async open(url,{Socket = WebSocket,timeout = 10000} = {}) {
    const socket = new Socket(url);
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => {try {socket.close();} catch {} reject(new LamodaError('browser_unavailable'));},timeout);
      socket.addEventListener('open',() => {clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',() => {clearTimeout(timer);reject(new LamodaError('browser_unavailable'));},{once:true});
    });
    return new CdpConnection(socket);
  }
  call(method,params = {},sessionId) {
    if (this.socket.readyState !== 1) return Promise.reject(new LamodaError('browser_unavailable'));
    return new Promise((resolve,reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {this.pending.delete(id);reject(new LamodaError('browser_unavailable'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      try {this.socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));}
      catch {clearTimeout(timer);this.pending.delete(id);reject(new LamodaError('browser_unavailable'));}
    });
  }
  close() {this.socket.close();}
}

export class WindowsLamodaBrowser {
  constructor({environment = process.env,platform = process.platform,fs = {existsSync,readFileSync},
    spawnProcess = spawn,fetchPage = fetch,connect = CdpConnection.open,wait = delay} = {}) {
    this.environment = environment;this.platform = platform;this.fs = fs;
    this.spawnProcess = spawnProcess;this.fetchPage = fetchPage;this.connect = connect;this.wait = wait;
  }
  async endpoint(portFile) {
    if (!this.fs.existsSync(portFile)) return null;
    const [number,path] = this.fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
    const port = Number(number);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || ''))
      throw new LamodaError('browser_unavailable');
    const response = await this.fetchPage('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new LamodaError('browser_unavailable');
    const version = await response.json();
    const url = 'ws://127.0.0.1:'+port+path;
    if (version.webSocketDebuggerUrl !== url) throw new LamodaError('browser_unavailable');
    return url;
  }
  async open() {
    if (this.platform !== 'win32') throw new LamodaError('browser_unavailable');
    const profile = profilePath(this.environment);
    const portFile = join(profile,'DevToolsActivePort');
    let endpoint = null;
    try {endpoint = await this.endpoint(portFile);} catch { /* A stale port file is handled by the launch timeout. */ }
    if (!endpoint) {
      const chrome = chromePath(this.environment);
      this.child = this.spawnProcess(chrome,['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
        '--start-minimized','--new-window','about:blank'],{cwd:dirname(chrome),windowsHide:true,stdio:'ignore'});
      this.owned = true;
      for (let attempt = 0; attempt < 150; attempt++) {
        try {endpoint = await this.endpoint(portFile);} catch { /* Chrome is still starting. */ }
        if (endpoint) break;
        if (this.child.exitCode != null || this.child.signalCode != null) break;
        await this.wait(100);
      }
    }
    if (!endpoint) throw new LamodaError('browser_unavailable');
    this.cdp = await this.connect(endpoint);
    const target = await this.cdp.call('Target.createTarget',{url:wishlistUrl,background:true});
    this.targetId = target.targetId;
    this.session = (await this.cdp.call('Target.attachToTarget',{targetId:this.targetId,flatten:true})).sessionId;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await this.cdp.call('Runtime.evaluate',{expression:'({origin:location.origin,ready:document.readyState})',returnByValue:true},this.session);
      const state = response.result?.value;
      if (['https://www.lamoda.ru','https://lamoda.ru'].includes(state?.origin)
        && ['interactive','complete'].includes(state?.ready)) return;
      await this.wait(200);
    }
    throw new LamodaError('browser_unavailable');
  }
  async readPage(page) {
    const response = await this.cdp.call('Runtime.evaluate',{
      expression:wishlistExpression(page),awaitPromise:true,returnByValue:true},this.session);
    const value = response.result?.value;
    if (response.exceptionDetails || !value || value.unverified) throw new LamodaError('account_unverified');
    if (value.status !== 200) throw new LamodaError(value.status === 429 ? 'rate_limited' : 'access_limited',retryAfter(value.retry),value.status);
    return value.html;
  }
  async collect(expectedDigest,{signal} = {}) {
    try {await this.open();return await collectWishlistPages(page => this.readPage(page),expectedDigest,{signal});}
    finally {await this.close();}
  }
  async close() {
    if (this.cdp) {
      try {if (this.targetId) await this.cdp.call('Target.closeTarget',{targetId:this.targetId});} catch {}
      try {if (this.owned) await this.cdp.call('Browser.close');} catch {}
      this.cdp.close();this.cdp = null;
    }
    if (this.owned && this.child?.exitCode === null) {
      await Promise.race([new Promise(resolve => this.child.once('exit',resolve)),this.wait(1000)]);
      if (this.child.exitCode === null) this.child.kill();
    }
    this.child = null;this.targetId = null;this.session = null;this.owned = false;
  }
}
