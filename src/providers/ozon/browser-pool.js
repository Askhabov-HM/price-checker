// One process owns the Chrome profile; connections lease it for a whole collection.
// Chrome opens favorites once at startup; idle maintenance does not reload it.
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
  // Observation never acquires a profile lease, launches Chrome, or interrupts login/collection.
  async inspect() {
    if (this.active) return {running:this.active.worker ? (this.active.worker.isAlive?.() ?? true) : null,
      mode:this.active.login ? 'login' : this.active.worker ? 'collecting' : 'starting',snapshot:this.active.login ? null : this.lastSnapshot || null};
    if (!this.available || this.closed) return {running:false,mode:'stopped',snapshot:null};
    if (this.inspection) return this.inspection;
    if (this.lastInspection && Date.now()-this.lastInspection.at < 2000) return this.lastInspection.value;
    const worker=this.worker;
    this.inspection = Promise.resolve().then(async () => {
      try {
        const result=await worker.send({inspect:true},6000);
        if (this.worker !== worker || this.closed) return {running:false,mode:'stopped',snapshot:null};
        this.lastSnapshot=result.snapshot || null;this.lastInspection={at:Date.now(),value:result};
        this.cancel(this.monitorTimer);
        this.monitorTimer=this.schedule(() => {this.lastSnapshot=null;this.lastInspection=null;},15000);
        this.monitorTimer?.unref?.();
        return result;
      } catch {return {running:this.available,mode:'unresponsive',snapshot:null};}
    });
    try {return await this.inspection;}
    finally {this.inspection=null;void this.drain();}
  }
  // Start Chrome with favorites open, without invoking the price collector.
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
    if (this.worker === worker) {this.worker = null;this.lastSnapshot=null;this.lastInspection=null;this.cancel(this.monitorTimer);}
    const inspection=this.inspection;
    this.retiring = this.retiring.catch(() => {}).then(async () => {await inspection?.catch(() => {});await worker.close();});
    return this.retiring;
  }
  async drain() {
    if (this.closed || this.active || this.inspection || !this.queue.length) return;
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
    this.closed = true;this.cancel(this.timer);this.cancel(this.monitorTimer);
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort',job.abort);job.reject(Error('Browser unavailable'));
    }
    if (this.active) await this.release(this.active);
    await this.retire(this.worker);
  }
}
