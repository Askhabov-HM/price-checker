import {appendFileSync,mkdirSync,mkdtempSync,writeFileSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export function diagnosticUrl(value) {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return 'blob:'+(diagnosticUrl(url.pathname) || '');
    if (!['http:','https:','chrome-extension:'].includes(url.protocol)) return url.protocol;
    return (url.protocol+'//'+url.host+url.pathname).slice(0,2000);
  } catch {return null;}
}
export function diagnosticHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    ['content-type','server','retry-after','x-sp-crid','x-request-id','x-correlation-id'].includes(name.toLowerCase()))
    .map(([name,value]) => [name.toLowerCase(),String(value).slice(0,1000)]));
}
function resources() {
  try {
    const group = readFileSync('/proc/self/cgroup','utf8').split('\n').find(line => line.startsWith('0::')).slice(3);
    const root = '/sys/fs/cgroup'+group;
    return {memory_bytes:Number(readFileSync(root+'/memory.current','utf8')),swap_bytes:Number(readFileSync(root+'/memory.swap.current','utf8')),
      cpu:Object.fromEntries(readFileSync(root+'/cpu.stat','utf8').trim().split('\n').map(line => line.split(/\s+/))),
      memory_events:Object.fromEntries(readFileSync(root+'/memory.events','utf8').trim().split('\n').map(line => line.split(/\s+/)))};
  } catch {return null;}
}

// Opt-in observation of the existing browser: no navigation, clicks, or requests.
export class LamodaDiagnostics {
  constructor(call,{directory = '/var/lib/price-checker-lamoda-browser/diagnostics',durationMs = 90000,maxBytes = 8*1024*1024} = {}) {
    this.call = call;this.durationMs = durationMs;this.maxBytes = maxBytes;this.bytes = 0;this.requests = new Map();this.sessions = new Set();
    mkdirSync(directory,{recursive:true,mode:0o700});if (lstatSync(directory).isSymbolicLink()) throw Error('Redirected diagnostics directory');
    this.directory = mkdtempSync(join(directory,'browser-'));this.path = join(this.directory,'events.ndjson');
    writeFileSync(this.path,'',{mode:0o600,flag:'wx'});this.counts = {requests:0,responses:0,network_errors:0,js_exceptions:0,console_errors:0};
  }
  write(event,data = {}) {
    if (this.closed) return;
    try {
      const line = JSON.stringify({at:new Date().toISOString(),event,...data})+'\n';
      if (Buffer.byteLength(line) > 128*1024 || this.bytes+Buffer.byteLength(line) > this.maxBytes) {this.truncated = true;return;}
      appendFileSync(this.path,line,{mode:0o600});this.bytes+=Buffer.byteLength(line);
    } catch {this.ioError = true;}
  }
  async command(method,params = {},sessionId = this.rootSession) {
    let timer;
    try {return await Promise.race([this.call(method,params,sessionId),new Promise((_,reject) => {timer=setTimeout(() => reject(Error('Diagnostic timeout')),5000);})]);}
    finally {clearTimeout(timer);}
  }
  async enable(sessionId) {
    if (this.sessions.has(sessionId) || this.closed) return;this.sessions.add(sessionId);
    for (const method of ['Network.enable','Runtime.enable','Log.enable']) {
      try {await this.command(method,method === 'Network.enable' ? {maxTotalBufferSize:4*1024*1024,maxResourceBufferSize:512*1024} : {},sessionId);}
      catch {this.write('domain_unavailable',{method,session_id:sessionId});}
    }
  }
  async start(sessionId) {
    this.rootSession = sessionId;this.write('recording_started',{duration_ms:this.durationMs});
    // Limits apply even if a protocol command cannot complete.
    this.timer = setTimeout(() => {void this.finish();},this.durationMs);this.timer.unref();
    this.sampleTimer = setInterval(() => this.write('resources',{value:resources()}),5000);this.sampleTimer.unref();
    this.write('resources',{value:resources()});await this.enable(sessionId);
    try {await this.command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});}
    catch {this.write('worker_observation_unavailable');}
  }
  event(message) {
    if (this.closed) return;
    const p = message.params || {},session = message.sessionId || this.rootSession;
    switch (message.method) {
      case 'Target.attachedToTarget':
        this.write('target_attached',{type:p.targetInfo?.type,url:diagnosticUrl(p.targetInfo?.url),session_id:p.sessionId});
        void this.enable(p.sessionId);break;
      case 'Network.requestWillBeSent':
        this.counts.requests++;
        this.write('request',{session_id:session,id:p.requestId,type:p.type,url:diagnosticUrl(p.request?.url),method:p.request?.method});
        if (p.redirectResponse) this.write('redirect',{id:p.requestId,url:diagnosticUrl(p.redirectResponse.url),status:p.redirectResponse.status,headers:diagnosticHeaders(p.redirectResponse.headers)});
        break;
      case 'Network.responseReceived':
        this.counts.responses++;
        this.write('response',{session_id:session,id:p.requestId,type:p.type,url:diagnosticUrl(p.response?.url),status:p.response?.status,
          protocol:p.response?.protocol,headers:diagnosticHeaders(p.response?.headers)});
        if (p.type === 'Document' && this.requests.size < 100) this.requests.set(session+':'+p.requestId,{session,id:p.requestId,url:diagnosticUrl(p.response?.url)});
        break;
      case 'Network.loadingFailed':
        this.counts.network_errors++;this.requests.delete(session+':'+p.requestId);
        this.write('network_error',{session_id:session,id:p.requestId,type:p.type,error:p.errorText,blocked_reason:p.blockedReason,canceled:p.canceled});break;
      case 'Network.loadingFinished': {
        const key = session+':'+p.requestId,request = this.requests.get(key);this.requests.delete(key);
        if (request && p.encodedDataLength <= 256*1024 && !this.capturingBody) {
          this.capturingBody = true;
          void this.command('Network.getResponseBody',{requestId:request.id},session).then(result => {
            if (this.closed) return;const body = Buffer.from(result.body || '',result.base64Encoded ? 'base64' : 'utf8');
            if (body.length <= 256*1024 && (this.bodyCount || 0) < 4) {
              const file = 'document-'+((this.bodyCount || 0)+1)+'.html';
              writeFileSync(join(this.directory,file),body,{mode:0o600,flag:'wx'});this.bodyCount = (this.bodyCount || 0)+1;
              this.write('document_saved',{url:request.url,file,bytes:body.length});
            }
          }).catch(() => this.write('document_unavailable',{url:request.url})).finally(() => {this.capturingBody = false;});
        }
        break;
      }
      case 'Runtime.exceptionThrown':
        this.counts.js_exceptions++;
        this.write('js_exception',{session_id:session,text:p.exceptionDetails?.text,url:diagnosticUrl(p.exceptionDetails?.url),
          description:p.exceptionDetails?.exception?.description?.slice(0,8000),line:p.exceptionDetails?.lineNumber,stack:p.exceptionDetails?.stackTrace});break;
      case 'Runtime.consoleAPICalled':
        if (['error','warning','warn'].includes(p.type)) {
          if (p.type === 'error') this.counts.console_errors++;
          this.write('console',{session_id:session,type:p.type,args:p.args?.slice(0,10).map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0,2000)),stack:p.stackTrace});
        }
        break;
      case 'Log.entryAdded':
        if (['error','warning'].includes(p.entry?.level)) this.write('log',{session_id:session,level:p.entry.level,source:p.entry.source,text:p.entry.text?.slice(0,4000),url:diagnosticUrl(p.entry.url)});
        break;
    }
  }
  async finish() {
    if (this.closed || this.finishing) return;this.finishing = true;
    try {
      const result = await this.command('Runtime.evaluate',{expression:'({url:location.origin+location.pathname,title:document.title,ready:document.readyState,screen:{width:screen.width,height:screen.height},window:{width:outerWidth,height:outerHeight}})',returnByValue:true});
      this.write('page',{value:result.result?.value,exception:!!result.exceptionDetails});
    } catch {this.write('page_unresponsive');}
    try {
      const result = await this.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      if (!this.closed && typeof result.data === 'string' && result.data.length < 4*1024*1024) writeFileSync(join(this.directory,'page.png'),Buffer.from(result.data,'base64'),{mode:0o600});
    } catch {this.write('screenshot_unavailable');}
    try {await this.command('Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});} catch {}
    this.close();
  }
  close() {
    if (this.closed) return;clearTimeout(this.timer);clearInterval(this.sampleTimer);
    this.write('recording_finished',{counts:this.counts,truncated:!!this.truncated,io_error:!!this.ioError,resources:resources()});
    try {writeFileSync(join(this.directory,'summary.json'),JSON.stringify({counts:this.counts,truncated:!!this.truncated,io_error:!!this.ioError},null,2),{mode:0o600});} catch {}
    this.closed = true;this.requests.clear();
  }
}
