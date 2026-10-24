import {appendFileSync,existsSync,renameSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireInstance,AlreadyRunning} from '../../src/instance.js';
import {DesktopApi,DesktopCredentials,collectOnce} from './desktop-api.js';

const interval = 15000;

export async function agentCycle({credentials,apiFactory = origin => new DesktopApi(origin),collect = collectOnce,
  current = Date.now} = {}) {
  const {origin,token} = await credentials.load();
  const config = await apiFactory(origin).config(token);
  const serverTime = Date.parse(config.server_time);
  const due = Date.parse(config.schedule?.next_check);
  const pause = Date.parse(config.not_before);
  if (config.mode !== 'staging' || !Number.isFinite(serverTime)) throw new Error('Invalid desktop configuration');
  if (config.schedule?.enabled && Number.isFinite(due) && due <= serverTime
    && !(Number.isFinite(pause) && pause > serverTime)) {
    return {collected:true,result:await collect({credentials,apiFactory,scheduled:true})};
  }
  const ahead = Number.isFinite(due) ? Math.max(1000,due-serverTime) : interval;
  return {collected:false,wait:Math.min(interval,ahead),server_time:serverTime,local_time:current()};
}

export async function runAgent({credentials = new DesktopCredentials(),cycle = agentCycle,wait = delay,
  acquire = acquireInstance,signal,log = () => {}} = {}) {
  const release = await acquire(join(credentials.directory,'desktop-agent.lock'));
  try {
    while (!signal?.aborted) {
      let waitMs = interval;
      try {
        const outcome = await cycle({credentials});
        waitMs = outcome.wait || interval;
        if (outcome.collected) log({event:'snapshot_saved',count:outcome.result.count,at:outcome.result.received_at});
      } catch (error) {
        waitMs = 30000;
        log({event:'agent_error',code:error?.code || 'unavailable',status:Number.isInteger(error?.status) ? error.status : null});
      }
      try {await wait(waitMs,undefined,{signal});} catch {if (!signal?.aborted) throw new Error('Desktop agent wait failed');}
    }
  } finally {await release();}
}

function writeLog(directory,event) {
  const path = join(directory,'agent.log');
  try {
    if (existsSync(path) && statSync(path).size > 1024*1024) renameSync(path,path+'.old');
    appendFileSync(path,JSON.stringify({time:new Date().toISOString(),...event})+'\n',{mode:0o600});
  } catch { /* Collection continues when local logging is unavailable. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const credentials = new DesktopCredentials(),controller = new AbortController();
  process.once('SIGINT',() => controller.abort());process.once('SIGTERM',() => controller.abort());
  runAgent({credentials,signal:controller.signal,log:event => writeLog(credentials.directory,event)})
    .catch(error => {if (!(error instanceof AlreadyRunning)) writeLog(credentials.directory,{event:'agent_stopped',code:error?.code || 'unavailable'});
      process.exitCode = error instanceof AlreadyRunning ? 0 : 1;});
}
