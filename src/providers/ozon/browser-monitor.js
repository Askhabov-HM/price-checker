import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writePrivateJson} from './session.js';

const IMAGE_LIMIT = 2*1024*1024;
const modes = ['idle','collecting','starting','login','stopped','blank','unresponsive','unavailable'];
const outcomes = ['access_limited','login_required','rate_limited','http_error','network_error',
  'response_too_large','unexpected_content','browser_error'];
const stamp = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value)) ? value : null;

export function safePageUrl(value) {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)ozon\.ru$/.test(url.hostname)) return null;
    // Challenge URLs can contain private tokens; the page image and pathname suffice.
    return (url.origin+url.pathname).slice(0,2000);
  } catch {return null;}
}

export function monitorSnapshot(value) {
  if (!value || !stamp(value.captured_at)) return null;
  const image = typeof value.image === 'string' && value.image.length <= IMAGE_LIMIT
    && value.image.length%4 === 0 && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value.image) ? value.image : null;
  return {captured_at:value.captured_at,url:safePageUrl(value.url),
    title:typeof value.title === 'string' ? value.title.slice(0,400) : '',
    ready_state:['loading','interactive','complete'].includes(value.ready_state) ? value.ready_state : 'unknown',image};
}

export function monitorFailure(value) {
  if (!value || !stamp(value.at) || !outcomes.includes(value.outcome)) return null;
  return {at:value.at,outcome:value.outcome,
    http_status:Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599 ? value.http_status : null,
    snapshot:monitorSnapshot(value.snapshot)};
}

export function monitorState(value = {}) {
  return {available:value.available === true,running:typeof value.running === 'boolean' ? value.running : null,
    mode:modes.includes(value.mode) ? value.mode : 'unavailable',checked_at:new Date().toISOString(),
    started_at:stamp(value.started_at),snapshot:value.mode === 'login' ? null : monitorSnapshot(value.snapshot),last_error:monitorFailure(value.last_error)};
}

export async function captureBrowserSnapshot(call,sessionId,{current = () => new Date().toISOString(),timeoutMs = 4000} = {}) {
  let timer,metadata;
  const deadline = new Promise((_,reject) => {timer=setTimeout(() => reject(Error('Snapshot timed out')),timeoutMs);});
  const read = (method,params) => Promise.race([call(method,params,sessionId),deadline]);
  try {
    const result = await read('Runtime.evaluate',{expression:'({url:location.href,title:document.title,ready:document.readyState})',returnByValue:true});
    const page = result.result?.value;
    if (result.exceptionDetails || !page || !safePageUrl(page.url)) return null;
    metadata={captured_at:current(),url:page.url,title:page.title,ready_state:page.ready};
    const captured = await read('Page.captureScreenshot',{format:'jpeg',quality:55,fromSurface:true,captureBeyondViewport:false});
    return monitorSnapshot({...metadata,captured_at:current(),image:captured.data});
  } catch {return monitorSnapshot(metadata);}
  finally {clearTimeout(timer);}
}

export function browserFailureStore(profile) {
  const path = profile ? join(profile,'price-checker-browser-error.json') : null;
  return {
    read() {
      try {
        if (!path) return null;
        const stat=lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > IMAGE_LIMIT+8000) return null;
        return monitorFailure(JSON.parse(readFileSync(path,'utf8')));
      } catch {return null;}
    },
    save(value) {
      const failure=monitorFailure(value);
      if (!path || !failure) return;
      try {writePrivateJson(path,failure);} catch { /* Snapshot storage cannot fail a collection. */ }
    },
  };
}
