import {connect} from 'node:net';
import {existsSync} from 'node:fs';
import {LamodaError} from './parser.js';

export const LAMODA_SOCKET = '/run/price-checker-lamoda/browser.sock';
export class LamodaChannel {
  constructor({path = process.env.LAMODA_BROWSER_SOCKET || LAMODA_SOCKET, signal, timeout = 590000} = {}) {
    this.path = path; this.signal = signal; this.timeout = timeout;
  }
  available() {return process.platform === 'linux' && existsSync(this.path);}
  request(action, fields = {}) {
    return new Promise((resolve,reject) => {
      if (this.signal?.aborted) {reject(new LamodaError('interrupted'));return;}
      const socket = connect(this.path); let buffer = Buffer.alloc(0), done = false;
      const finish = (error,value) => {
        if (done) return;done = true;clearTimeout(timer);this.signal?.removeEventListener('abort',abort);socket.destroy();
        if (error) reject(error);else resolve(value);
      };
      const abort = () => finish(new LamodaError('interrupted'));
      const timer = setTimeout(() => finish(new LamodaError('browser_unavailable')),this.timeout);
      this.signal?.addEventListener('abort',abort,{once:true});
      socket.once('connect',() => socket.write(JSON.stringify({version:1,action,...fields})+'\n'));
      socket.on('data',chunk => {
        buffer = Buffer.concat([buffer,chunk]);
        if (buffer.length > 16*1024*1024) {finish(new LamodaError('invalid_data'));return;}
        if (!buffer.includes(10)) return;
        try {
          const result = JSON.parse(buffer.subarray(0,buffer.indexOf(10)).toString('utf8'));
          if (result.version !== 1) throw new Error();
          if (!result.ok) finish(new LamodaError(result.code,result.retry_after_ms || 0,result.http_status || null));
          else finish(null,result.data);
        } catch {finish(new LamodaError('invalid_data'));}
      });
      socket.once('error',() => finish(new LamodaError('browser_unavailable')));
      socket.once('end',() => {if (!done) finish(new LamodaError('browser_unavailable'));});
    });
  }
}
