import {connect} from 'node:net';
import {existsSync} from 'node:fs';

export const RECOVERY_SOCKET = '/run/price-checker-ozon-recovery.sock';
export const RECOVERY_LIMIT = 12 * 1024 * 1024;

// The socket is owned by the application user. No shell, root command or public CDP port.
export function browserRecovery({request, signal}, {path = RECOVERY_SOCKET, timeoutMs = 60000} = {}) {
  if (!existsSync(path) || signal?.aborted) return Promise.reject(new Error('Recovery unavailable'));
  return new Promise((resolve, reject) => {
    const socket = connect(path); let bytes = 0, chunks = [], settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      error ? reject(new Error('Recovery unavailable')) : resolve(value);
    };
    const abort = () => finish(true);
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, {once:true});
    socket.on('error', abort);
    socket.on('end', abort);
    socket.on('connect', () => socket.write(JSON.stringify({version:1,request})+'\n'));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > RECOVERY_LIMIT) return abort();
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {finish(false, JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch {abort();}
    });
    if (signal?.aborted) abort();
  });
}
