import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RECOVERY_LIMIT} from './recovery.js';

// The child and Chrome run as ozonbrowser. Only bounded, private JSON uses stdio.
export function launchBrowserWorker({persistent}) {
  const child = spawn(process.execPath,[fileURLToPath(new URL('../../../scripts/ozon-recovery-worker.js',import.meta.url)),
    ...(persistent ? ['--persistent'] : [])],{stdio:['pipe','pipe','ignore']});
  let sequence = 0,pending,buffer = Buffer.alloc(0),stopping;
  const fail = () => {
    if (pending) {clearTimeout(pending.timer);pending.reject(Error('Browser unavailable'));pending = null;}
  };
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
  child.stdout.on('data',chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    if (buffer.length > RECOVERY_LIMIT) {fail();child.kill('SIGTERM');return;}
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    try {
      const result = JSON.parse(buffer.subarray(0,newline).toString('utf8'));
      if (!pending || newline !== buffer.length-1 || result.version !== 2 || result.id !== pending.id || result.error) throw Error();
      buffer = Buffer.alloc(0);
      const current = pending;pending = null;clearTimeout(current.timer);current.resolve(result);
    } catch {fail();child.kill('SIGTERM');}
  });
  const send = (message,timeout = 60000) => new Promise((resolve,reject) => {
    if (pending || child.exitCode !== null || child.signalCode !== null || !child.pid) return reject(Error('Browser unavailable'));
    const id = ++sequence,body = JSON.stringify({...message,version:2,id})+'\n';
    if (Buffer.byteLength(body) > 262144) return reject(Error('Browser request too large'));
    const timer = setTimeout(() => {fail();child.kill('SIGTERM');},timeout);
    pending = {id,timer,resolve,reject};child.stdin.write(body);
  });
  return {
    send,
    isAlive: () => !!child.pid && child.exitCode === null && child.signalCode === null,
    close() {
      return stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
        try {if (!pending) await send({close:true},5000);} catch { /* SIGTERM also cleans up Chrome. */ }
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => {
          const timer = setTimeout(() => child.kill('SIGKILL'),8000);timer.unref();
          child.once('exit',() => {clearTimeout(timer);resolve();});
          child.kill('SIGTERM');
        });
      })();
    },
  };
}
