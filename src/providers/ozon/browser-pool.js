// One process owns the Chrome profile; connections lease it for a whole collection.
// No Ozon requests or page reloads are made while it is idle.
export function browserIdleMs(env = process.env) {
  const minutes = env.OZON_BROWSER_IDLE_MINUTES ?? '0';
  if (!/^(?:0|[1-9]\d{0,3})$/.test(minutes) || Number(minutes) > 1440) throw Error('Invalid Ozon browser idle timeout');
  return Number(minutes)*60000;
}

export class PersistentBrowserPool {
  constructor({launch,idleMs = browserIdleMs(),schedule = setTimeout,cancel = clearTimeout}) {
    this.launch = launch;this.idleMs = idleMs;this.schedule = schedule;this.cancel = cancel;
    this.queue = [];this.worker = null;this.active = null;this.retiring = Promise.resolve();
  }
  get available() {return !!this.worker && (this.worker.isAlive?.() ?? true);}
  // Start Chrome on about:blank without navigating or reading Ozon while idle.
  async ensureWarm() {
    if (this.closed || this.idleMs !== 0 || this.active || this.queue.length || this.available) return;
    const lease = await this.acquire();
    try {
      const result = await lease.send({warmup:true});
      if (!result.ready) throw Error('Browser unavailable');
    } catch (error) {await this.retire(this.worker);throw error;}
    finally {await lease.release();}
  }
  acquire({login = false,signal} = {}) {
    if (this.closed || signal?.aborted || this.queue.length >= 8) return Promise.reject(Error('Browser unavailable'));
    return new Promise((resolve,reject) => {
      const job = {login,signal,resolve,reject};
      job.abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {this.queue.splice(index,1);reject(Error('Browser unavailable'));}
      };
      signal?.addEventListener('abort',job.abort,{once:true});
      this.queue.push(job);void this.drain();
    });
  }
  retire(worker) {
    if (!worker) return this.retiring;
    if (this.worker === worker) this.worker = null;
    this.retiring = this.retiring.catch(() => {}).then(() => worker.close());
    return this.retiring;
  }
  async drain() {
    if (this.closed || this.active || !this.queue.length) return;
    const job = this.queue.shift(), lease = {login:job.login,worker:null,pending:null,closed:false,failed:false};
    this.active = lease;this.cancel(this.timer);
    job.signal?.removeEventListener('abort',job.abort);
    try {
      lease.initializing = (async () => {
        if (job.login || this.worker && !this.available) await this.retire(this.worker);
        await this.retiring;
        if (this.closed || job.signal?.aborted) throw Error('Browser unavailable');
        lease.worker = this.worker || await this.launch({persistent:!job.login});
        if (!job.login) this.worker = lease.worker;
        if (this.closed || job.signal?.aborted) throw Error('Browser unavailable');
      })();
      await lease.initializing;
      job.resolve({
        send: message => {
          if (lease.closed || lease.failed || lease.pending || this.closed) return Promise.reject(Error('Browser unavailable'));
          const pending = Promise.resolve().then(() => lease.worker.send(message));
          lease.pending = pending;
          return pending.catch(error => {lease.failed = true;throw error;}).finally(() => {lease.pending = null;});
        },
        release: () => this.release(lease),
      });
    } catch {
      lease.failed = true;
      await this.release(lease);
      job.reject(Error('Browser unavailable'));
    }
  }
  release(lease) {
    if (lease.releasing) return lease.releasing;
    lease.closed = true;
    return lease.releasing = (async () => {
      try {
        try {await lease.initializing;} catch {lease.failed = true;}
        try {await lease.pending;} catch {lease.failed = true;}
        if (lease.login || lease.failed || this.closed) await this.retire(lease.worker);
        else if (lease.worker) {
          try {
            const result = await lease.worker.send({release:true});
            if (!result.released) throw Error('Browser release failed');
          } catch {await this.retire(lease.worker);}
        }
      } finally {
        if (this.active === lease) this.active = null;
        if (!this.closed && this.idleMs > 0 && this.worker && !this.queue.length) {
          this.timer = this.schedule(() => {void this.retire(this.worker).catch(() => {});},this.idleMs);
          this.timer?.unref?.();
        }
        void this.drain();
      }
    })();
  }
  async close() {
    this.closed = true;this.cancel(this.timer);
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort',job.abort);job.reject(Error('Browser unavailable'));
    }
    if (this.active) await this.release(this.active);
    await this.retire(this.worker);
  }
}
