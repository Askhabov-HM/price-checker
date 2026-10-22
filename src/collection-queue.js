import {mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireInstance, AlreadyRunning} from './instance.js';

const queues = new Map();
function lockPath(root) {
  const directory = join(root,'.data');
  mkdirSync(directory,{recursive:true});
  // Releases and the repository may point at the same persistent data directory.
  return join(realpathSync(directory),'collection.lock');
}

export async function acquireCollection(root,signal,onWaiting = () => {}) {
  const path = lockPath(root);
  while (true) {
    signal?.throwIfAborted();
    try {return await acquireInstance(path);}
    catch (error) {
      if (!(error instanceof AlreadyRunning)) throw error;
      onWaiting();
      await delay(250,undefined,{signal});
    }
  }
}

export class CollectionQueue {
  constructor(root) {this.root = root;this.jobs = [];this.active = null;}
  status(store) {
    const index = this.jobs.findIndex(job => job.store === store);
    return {queued:index !== -1 && this.jobs[index] !== this.active,
      queue_position:index === -1 || this.jobs[index] === this.active ? null : index+1-(this.active ? 1 : 0),
      active_store:this.active?.store ?? null};
  }
  enqueue(store,operation,{signal} = {}) {
    const existing = this.jobs.find(job => job.store === store);
    if (existing) return existing.ticket;
    const done = Promise.withResolvers(),ready = Promise.withResolvers();
    const job = {store,operation,signal,done,ready,ticket:{done:done.promise,ready:ready.promise}};
    // Cancellation must be safe even if nobody awaits a fire-and-forget request.
    done.promise.catch(() => {});
    job.abort = () => {
      if (this.jobs[0] === job) return; // The pump owns admission/active cleanup.
      this.jobs = this.jobs.filter(candidate => candidate !== job);
      signal?.removeEventListener('abort',job.abort);
      ready.resolve();done.reject(signal.reason);
    };
    this.jobs.push(job);
    signal?.addEventListener('abort',job.abort,{once:true});
    if (this.jobs.length === 1) void this.pump(job);
    else {ready.resolve();if (signal?.aborted) job.abort();}
    return job.ticket;
  }
  async pump(job) {
    let release,result,error;
    try {
      release = await acquireCollection(this.root,job.signal,() => job.ready.resolve());
      job.signal?.throwIfAborted();
      this.active = job;
      const work = job.operation();
      job.ready.resolve();
      // Never release the lock on a timeout race: the actual work must finish.
      result = await work;
    } catch (cause) {error = cause;}
    finally {
      try {await release?.();} catch (cause) {error ??= cause;}
      job.signal?.removeEventListener('abort',job.abort);
      this.active = null;
      this.jobs.shift();
      job.ready.resolve();
      if (error) job.done.reject(error);else job.done.resolve(result);
      if (this.jobs.length) void this.pump(this.jobs[0]);
    }
  }
}

export function collectionQueue(root) {
  const path = lockPath(root);
  if (!queues.has(path)) queues.set(path,new CollectionQueue(root));
  return queues.get(path);
}
