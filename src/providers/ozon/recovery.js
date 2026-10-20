import {connect} from 'node:net';
import {existsSync} from 'node:fs';
import {validateCapturedRequest} from './network-capture.js';

export const RECOVERY_SOCKET = '/run/price-checker-ozon-recovery.sock';
export const RECOVERY_LIMIT = 12 * 1024 * 1024;

// A connection leases the browser for one collection. The service owns its lifetime.
export function browserCollection({signal,cookies = []} = {}, {path = RECOVERY_SOCKET, timeoutMs = 60000} = {}) {
  if (!existsSync(path) || signal?.aborted) throw new Error('Browser unavailable');
  const socket = connect(path);
  let sequence = 0, pending, buffer = Buffer.alloc(0), closed = false;
  const fail = () => {
    closed = true;socket.destroy();signal?.removeEventListener('abort',fail);
    if (pending) {clearTimeout(pending.timer);pending.reject(new Error('Browser unavailable'));pending = null;}
  };
  signal?.addEventListener('abort',fail,{once:true});
  socket.on('error',fail);socket.on('end',fail);socket.on('close',fail);
  socket.on('data',chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    if (buffer.length > RECOVERY_LIMIT) return fail();
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    try {
      const value = JSON.parse(buffer.subarray(0,newline).toString('utf8'));
      if (!pending || value.version !== 2 || value.id !== pending.id || newline !== buffer.length-1) return fail();
      buffer = Buffer.alloc(0);
      const current = pending;pending = null;clearTimeout(current.timer);current.resolve(value);
    } catch {fail();}
  });
  const send = (message, timeout = timeoutMs) => new Promise((resolve,reject) => {
    if (closed || signal?.aborted || pending) return reject(new Error('Browser unavailable'));
    const id = ++sequence,output = JSON.stringify({version:2,id,...message})+'\n';
    if (Buffer.byteLength(output) > 262144) {fail();return reject(new Error('Browser unavailable'));}
    const timer = setTimeout(fail,timeout);
    pending = {id,timer,resolve,reject};
    socket.write(output);
  });
  return {
    resume() {return send({resume:true});},
    read(request) {const verified = validateCapturedRequest(request);return send({request:{...verified,headers:{}},...(sequence === 0 ? {cookies} : {})});},
    login(action, data = {}) {
      if (!['start','phone','finish'].includes(action)) throw new Error('Unsupported login action');
      return send({...data,login:action});
    },
    async close() {
      if (closed) return;
      try {await send({close:true},5000);} catch { /* The server also releases disconnected leases. */ }
      finally {fail();}
    },
  };
}

export async function resumeBrowserCollection(options = {},settings = {}) {
  if (!existsSync(settings.path || RECOVERY_SOCKET)) return null;
  let channel;
  try {
    channel = browserCollection(options,settings);
    if ((await channel.resume()).available === true) return channel;
  } catch { /* Only probes availability; collections always use the browser. */ }
  await channel?.close();
  return null;
}
