import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {WindowsLamodaBrowser} from './cdp-browser.js';
import {acquireInstance} from '../../src/instance.js';
import {retryCollectionRead} from '../../src/collection-retry.js';
import {LamodaError} from '../../src/providers/lamoda/parser.js';

export const defaultServer = 'https://153.76.171.172';

export function serverOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw new Error('Server must be an HTTPS origin without a path');
  return url.origin;
}

export class DesktopApi {
  constructor(origin = defaultServer,{fetchRequest = fetch} = {}) {
    this.origin = serverOrigin(origin);this.fetchRequest = fetchRequest;
  }
  async request(action,{token,body,signal} = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await this.fetchRequest(this.origin+'/api/lamoda-desktop/'+action,{
      method,headers:{...(token ? {Authorization:'Bearer '+token} : {}),
        ...(body === undefined ? {} : {'Content-Type':'application/json'})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:signal || AbortSignal.timeout(60000),redirect:'error',
    });
    if (!response.ok) {
      const error = new Error('Desktop API '+action+' returned HTTP '+response.status);
      error.status = response.status;
      error.retryAfter = response.headers.get('Retry-After');
      throw error;
    }
    return response.json();
  }
  pair(code) {return this.request('pair',{body:{code,name:'Windows laptop'}});}
  config(token) {return this.request('config',{token});}
  start(token,{scheduled = false} = {}) {return this.request('start',{token,body:{scheduled}});}
  job(token,id) {return this.request('job?id='+encodeURIComponent(id),{token});}
  fail(token,id,error) {return this.request('fail',{token,body:{job_id:id,
    code:error instanceof LamodaError ? error.code : 'invalid_data',
    retry_after_ms:error instanceof LamodaError ? error.retry_after_ms : 0,
    http_status:error instanceof LamodaError ? error.http_status : null}});}
  snapshot(token,jobId,runId,pages) {return this.request('snapshot',{token,body:{job_id:jobId,run_id:runId,pages}});}
}

const protectScript = `Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($inputText); `+
  `$sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); `+
  `[Console]::Out.Write([Convert]::ToBase64String($sealed))`;
const unprotectScript = `Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); $sealed=[Convert]::FromBase64String($inputText); `+
  `$bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); `+
  `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))`;

export function dpapi(value,{decrypt = false,spawnProcess = spawn} = {}) {
  return new Promise((resolve,reject) => {
    const child = spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',decrypt ? unprotectScript : protectScript],
      {windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output = '';
    child.stdout.on('data',chunk => {
      output += chunk;
      if (output.length > 8192) child.kill();
    });
    child.once('error',() => reject(new Error('Windows credential protection unavailable')));
    child.once('close',code => code === 0 && output ? resolve(output) : reject(new Error('Windows credential protection unavailable')));
    child.stdin.end(value);
  });
}

export class DesktopCredentials {
  constructor({environment = process.env,seal = value => dpapi(value),open = value => dpapi(value,{decrypt:true})} = {}) {
    if (!environment.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable');
    this.directory = join(environment.LOCALAPPDATA,'PriceChecker','LamodaCollector');
    this.path = join(this.directory,'desktop-device.json');
    this.seal = seal;this.open = open;
  }
  async save(origin,token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid device token');
    const data = JSON.stringify({version:1,origin:serverOrigin(origin),protected_token:await this.seal(token)});
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const temporary = this.path+'.'+randomBytes(6).toString('hex');
    try {
      writeFileSync(temporary,data,{mode:0o600,flag:'wx'});
      renameSync(temporary,this.path);
    } finally {rmSync(temporary,{force:true});}
  }
  async load() {
    const data = JSON.parse(readFileSync(this.path,'utf8'));
    if (data.version !== 1 || typeof data.protected_token !== 'string') throw new Error('Invalid desktop credential');
    const token = await this.open(data.protected_token);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid desktop credential');
    return {origin:serverOrigin(data.origin),token};
  }
}

export async function collectOnce({credentials = new DesktopCredentials(),browser = new WindowsLamodaBrowser(),
  apiFactory = origin => new DesktopApi(origin),acquire = acquireInstance,wait = delay,current = Date.now,scheduled = false} = {}) {
  const release = await acquire(join(credentials.directory,'desktop-collector.lock'));
  try {
    const {origin,token} = await credentials.load();
    const api = apiFactory(origin);
    const config = await api.config(token);
    if (config.mode !== 'staging' || !/^[a-f0-9]{64}$/.test(config.account_digest || ''))
      throw new Error('Desktop staging is not configured on the server');
    const offset = Number.isFinite(Date.parse(config.server_time)) ? Date.parse(config.server_time)-current() : 0;
    const serverNow = () => current()+offset;
    const started = await api.start(token,{scheduled});
    const jobId = started.job?.id;
    if (!/^[a-f0-9]{32}$/.test(jobId || '')) throw new Error('Desktop job was not issued');
    let finished = false,failure;
    try {
      let job = started.job;
      while (job.status === 'queued') {
        await wait(2000);
        job = (await api.job(token,jobId)).job;
      }
      if (job.status !== 'active') throw new Error('Desktop job expired before collection');
      const deadline = Date.parse(job.expires_at);
      if (!Number.isFinite(deadline) || deadline <= serverNow()) throw new Error('Desktop job has no active deadline');
      const signal = AbortSignal.timeout(Math.max(1,deadline-serverNow()));
      const {pages,count} = await retryCollectionRead(() => browser.collect(config.account_digest,{signal}),{
        signal,wait,retryable:error => error instanceof LamodaError
          && !['login_required','account_mismatch','interrupted'].includes(error.code),pause:wait});
      const runId = randomBytes(16).toString('hex');
      let result;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {result = await api.snapshot(token,jobId,runId,pages);break;}
        catch (error) {
          if (attempt === 4 || error.status && error.status < 500 || error.retryAfter || deadline-serverNow() <= 5000) throw error;
          await wait(5000);
        }
      }
      if (result.run_id !== runId || result.count !== count) throw new Error('Desktop snapshot confirmation is inconsistent');
      finished = true;
      return {count,received_at:result.received_at,run_id:runId};
    } catch (error) {failure = error;throw error;}
    finally {if (!finished) try {await api.fail(token,jobId,failure);} catch {}}
  } finally {await release();}
}
