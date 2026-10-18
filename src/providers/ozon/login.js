import {readFileSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {acquireInstance} from '../../instance.js';
import {ValidationError} from '../../errors.js';
import {browserCollection, RECOVERY_SOCKET} from './recovery.js';
import {accountMatches} from './account-context.js';
import {validateCapturedRequest} from './network-capture.js';
import {importOzonConnection} from './connection.js';
import {writePrivateJson} from './session.js';

const duration = 20*60000;
const pagePath = '/ozon/login';
const unavailable = () => new ValidationError('Окно входа Ozon недоступно. Попробуйте открыть его заново.');
function privateJson(path) {
  if (statSync(path).size > 1024*1024) throw unavailable();
  return JSON.parse(readFileSync(path,'utf8'));
}

export class OzonLogin {
  constructor(root, {notify,onAuthorized,publicOrigin = process.env.PRICE_CHECKER_PUBLIC_ORIGIN,
    browser = browserCollection,isBrowserAvailable = () => process.platform === 'linux' && existsSync(RECOVERY_SOCKET)} = {}) {
    this.root = root;this.directory = join(root,'.secrets/ozon');this.notify = notify;this.onAuthorized = onAuthorized;
    this.required = false;this.sockets = new Set();this.closed = false;
    this.createBrowser = browser;this.isBrowserAvailable = isBrowserAvailable;
    if (publicOrigin) {
      const url = new URL(publicOrigin);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw unavailable();
      this.url = url.origin+pagePath;
    }
  }
  phone() {
    try {const phone = privateJson(join(this.directory,'login.json')).phone;return /^\+7\d{10}$/.test(phone) ? phone : null;} catch {return null;}
  }
  status() {
    const phone = this.phone();
    return {required:this.required,available:this.isBrowserAvailable() && !!phone,
      active:!!this.session,expires_at:this.session?.expires_at || null,phone_hint:phone ? '••• '+phone.slice(-4) : null};
  }
  async require() {
    if (this.closed) return;
    this.required = true;
    const path = join(this.directory,'login-notification.json');
    let previous;
    try {previous = privateJson(path);} catch { /* First notification. */ }
    if (!this.notify || !this.url || Date.now()-(previous?.sent_at || 0) < 30*60000) return;
    if (!this.notification) this.notification = (async () => {
      try {
        await this.notify('Ozon: требуется вход в аккаунт. Открой окно, авторизуйся и нажми «Сохранить вход».\n'+this.url);
        writePrivateJson(path,{sent_at:Date.now()});
      } catch { /* Keep the request visible in the app; the next scheduler tick retries. */ }
    })().finally(() => {this.notification = null;});
    return this.notification;
  }
  connection(owner) {
    if (!this.session || this.session.owner !== owner || Date.now() >= this.session.expires) throw unavailable();
    return this.session;
  }
  async start(owner) {
    if (this.closed || !this.status().available) throw unavailable();
    if (this.session) return this.view(owner);
    if (this.starting) throw new ValidationError('Окно Ozon уже открывается. Подождите.');
    this.starting = true;
    this.opening = {owner,controller:new AbortController()};
    let release, channel;
    try {
      release = await acquireInstance(join(this.root,'.data/ozon/collector.lock'));
      const config = privateJson(join(this.directory,'connection.json'));
      if (!/^[1-9]\d{0,19}$/.test(config.reference?.account_id)) throw unavailable();
      const request = validateCapturedRequest({method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url='+encodeURIComponent('/my/favorites?sorting=last_added'),headers:config.headers});
      const expires = Date.now()+duration;
      channel = this.createBrowser({signal:AbortSignal.any([AbortSignal.timeout(duration),this.opening.controller.signal])});
      const result = await channel.login('start',{phone:this.phone(),request});
      if (!Number.isInteger(result.view?.port) || result.view.port < 1024 || result.view.port > 65535
        || typeof result.view.password !== 'string' || result.view.password.length !== 8) throw unavailable();
      if (this.closed || this.opening.controller.signal.aborted) throw unavailable();
      this.session = {owner,channel,release,config,request,...result.view,nonce:randomBytes(32).toString('base64url'),expires,expires_at:new Date(expires).toISOString()};
      this.timer = setTimeout(() => {void this.cancel().catch(() => {});},Math.max(0,expires-Date.now()));this.timer.unref();
      return this.view(owner);
    } catch {
      await channel?.close();await release?.();throw unavailable();
    } finally {this.starting = false;this.opening = null;}
  }
  view(owner) {
    const session = this.connection(owner);
    return {...this.status(),websocket_path:'/api/providers/ozon/login/view?token='+session.nonce,password:session.password};
  }
  async fillPhone(owner) {
    const session = this.connection(owner);
    const result = await session.channel.login('phone');
    if (!result.filled) throw new ValidationError('Нажмите «Войти» в окне Ozon и откройте поле телефона, затем повторите.');
    return {filled:true};
  }
  async finish(owner) {
    const session = this.connection(owner);
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      const result = await session.channel.login('finish');
      if (result.http_status !== 200 || result.outcome !== 'json_received'
        || !accountMatches(result.data,session.config.reference,{requireLoginFlag:true})) {
        throw new ValidationError('Вход в нужный аккаунт ещё не подтверждён. Завершите авторизацию в окне Ozon.');
      }
      if (!result.exported?.cookies?.length || typeof result.user_agent !== 'string') throw unavailable();
      if (this.closed || this.session !== session || Date.now() >= session.expires) throw unavailable();
      await importOzonConnection(this.root,{request:{...session.request,headers:{...session.request.headers,'user-agent':result.user_agent}},reference:session.config.reference},result.exported);
      await this.onAuthorized?.();
      this.required = false;
      writePrivateJson(join(this.directory,'login-notification.json'),{sent_at:0});
      await this.endSession(session);
      return {authorized:true};
    })().finally(() => {this.finishing = null;});
    return this.finishing;
  }
  async cancel(owner) {
    if (owner !== undefined && this.session?.owner !== owner && this.opening?.owner !== owner) throw unavailable();
    this.opening?.controller.abort();
    if (this.finishing) await this.finishing.catch(() => {});
    await this.endSession(this.session);
  }
  async endSession(session) {
    if (session !== this.session) return;
    this.session = null;
    clearTimeout(this.timer);
    for (const socket of this.sockets) socket.destroy();this.sockets.clear();
    if (session) {try {await session.channel.close();} finally {await session.release();}}
  }
  upgrade(request, socket, head, owner) {
    let session;
    try {
      session = this.connection(owner);
      if (new URL(request.url,'http://localhost').searchParams.get('token') !== session.nonce) throw unavailable();
    } catch {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    this.sockets.add(socket);
    const upstream = httpRequest({host:'127.0.0.1',port:session.port,path:'/',headers:{host:'127.0.0.1:'+session.port,
      connection:'Upgrade',upgrade:'websocket','sec-websocket-key':request.headers['sec-websocket-key'],
      'sec-websocket-version':request.headers['sec-websocket-version'],
      ...(request.headers['sec-websocket-protocol'] ? {'sec-websocket-protocol':request.headers['sec-websocket-protocol']} : {})}});
    upstream.setTimeout(10000,() => upstream.destroy());
    upstream.once('upgrade',(response, remote, remoteHead) => {
      if (this.session !== session || socket.destroyed) {remote.destroy();return;}
      const headers = ['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade',
        'Sec-WebSocket-Accept: '+response.headers['sec-websocket-accept']];
      if (response.headers['sec-websocket-protocol']) headers.push('Sec-WebSocket-Protocol: '+response.headers['sec-websocket-protocol']);
      socket.write(headers.join('\r\n')+'\r\n\r\n');
      remote.setTimeout(0);
      if (head.length) remote.write(head);if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote);remote.pipe(socket);
      socket.once('close',() => remote.destroy());remote.once('close',() => socket.destroy());remote.on('error',() => socket.destroy());
    });
    upstream.once('response',response => {response.resume();socket.destroy();});
    upstream.on('error',() => socket.destroy());
    socket.on('error',() => upstream.destroy());
    socket.once('close',() => {this.sockets.delete(socket);upstream.destroy();});
    upstream.end();
  }
  async close() {this.closed = true;await this.cancel();}
}
