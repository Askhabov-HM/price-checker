import {randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {acquireInstance} from '../../instance.js';
import {join} from 'node:path';
import {ValidationError} from '../../errors.js';
import {LamodaChannel} from './channel.js';

const unavailable = () => new ValidationError('Окно входа Lamoda недоступно. Откройте его заново.');
export class LamodaLogin {
  constructor(root,{db,onAuthorized,channel = () => new LamodaChannel()} = {}) {
    this.root = root;this.db = db;this.onAuthorized = onAuthorized;this.channel = channel;this.sockets = new Set();
  }
  status() {return {available:this.channel().available(),active:!!this.session,expires_at:this.session?.expires_at ?? null,required:!!this.db.state().action_required || !this.db.configured()};}
  connection(owner) {if (!this.session || this.session.owner !== owner || Date.now() >= this.session.expires) throw unavailable();return this.session;}
  async start(owner) {
    if (this.closed || this.opening) throw unavailable();
    if (this.session) return this.view(owner);
    this.opening = true; let release,remote;
    try {
      release = await acquireInstance(join(this.root,'.data/lamoda/collector.lock'));
      remote = await this.channel().request('login_start');
      if (!Number.isInteger(remote.port) || remote.port < 1024 || remote.port > 65535 || !/^[A-Za-z0-9_-]{8}$/.test(remote.password) || !/^[a-f0-9]{64}$/.test(remote.key)) throw unavailable();
      if (this.closed) throw unavailable();
      const expires = Date.now()+20*60000;
      this.session = {owner,remote,release,expires,expires_at:new Date(expires).toISOString(),nonce:randomBytes(32).toString('hex')};
      this.timer = setTimeout(() => {this.cancel().catch(() => {});},20*60000);this.timer.unref();
      return this.view(owner);
    } catch {
      if (remote?.key) await this.channel().request('login_cancel',{key:remote.key}).catch(() => {});
      await release?.();throw unavailable();
    } finally {this.opening = false;}
  }
  view(owner) {const session = this.connection(owner);return {...this.status(),password:session.remote.password,websocket_path:'/api/providers/lamoda/login/view?token='+session.nonce};}
  async finish(owner) {
    const session = this.connection(owner);
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      const result = await this.channel().request('login_verify',{key:session.remote.key});
      this.connection(owner);
      // The existing account binding can never be replaced by a different login.
      this.db.bindAccount(result.account_id);
      await this.channel().request('login_finish',{key:session.remote.key,account_id:result.account_id});
      await this.end(session);
      await this.onAuthorized?.();
      return {authorized:true};
    })().finally(() => {this.finishing = null;});
    return this.finishing;
  }
  async end(session) {
    if (this.session !== session) return;
    this.session = null;clearTimeout(this.timer);
    for (const socket of this.sockets) socket.destroy();this.sockets.clear();
    await session.release();
  }
  async cancel(owner) {
    if (this.finishing) await this.finishing.catch(() => {});
    if (!this.session) return;
    if (owner !== undefined && owner !== this.session.owner) throw unavailable();
    const session = this.session;
    try {await this.channel().request('login_cancel',{key:session.remote.key});} finally {await this.end(session);}
  }
  upgrade(request,socket,head,owner) {
    let session;
    try {session = this.connection(owner);if (new URL(request.url,'http://localhost').searchParams.get('token') !== session.nonce) throw unavailable();}
    catch {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    this.sockets.add(socket);
    const upstream = httpRequest({host:'127.0.0.1',port:session.remote.port,path:'/',headers:{host:'127.0.0.1:'+session.remote.port,
      connection:'Upgrade',upgrade:'websocket','sec-websocket-key':request.headers['sec-websocket-key'],'sec-websocket-version':request.headers['sec-websocket-version'],
      ...(request.headers['sec-websocket-protocol'] ? {'sec-websocket-protocol':request.headers['sec-websocket-protocol']} : {})}});
    upstream.setTimeout(10000,() => upstream.destroy());
    upstream.once('upgrade',(response,remote,remoteHead) => {
      if (this.session !== session || socket.destroyed) {remote.destroy();return;}
      const headers = ['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Accept: '+response.headers['sec-websocket-accept']];
      if (response.headers['sec-websocket-protocol']) headers.push('Sec-WebSocket-Protocol: '+response.headers['sec-websocket-protocol']);
      socket.write(headers.join('\r\n')+'\r\n\r\n');remote.setTimeout(0);
      if (head.length) remote.write(head);if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote);remote.pipe(socket);socket.once('close',() => remote.destroy());remote.once('close',() => socket.destroy());remote.on('error',() => socket.destroy());
    });
    upstream.once('response',response => {response.resume();socket.destroy();});upstream.on('error',() => socket.destroy());
    socket.on('error',() => upstream.destroy());socket.once('close',() => {this.sockets.delete(socket);upstream.destroy();});upstream.end();
  }
  async close() {this.closed = true;await this.cancel();}
}
