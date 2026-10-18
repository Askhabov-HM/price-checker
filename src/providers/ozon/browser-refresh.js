import {validateCapturedRequest} from './network-capture.js';
import {ozonProduct} from './url.js';
import {pathMatch} from 'tough-cookie';
import {OZON_JSON_PATH} from './session.js';

export function browserCookieParams(cookies, now = Date.now()) {
  if (!Array.isArray(cookies) || cookies.length > 200) throw new Error('Invalid browser session');
  return cookies.flatMap(cookie => {
    if (!['ozon.ru','www.ozon.ru'].includes(cookie?.domain) || typeof cookie.hostOnly !== 'boolean'
      || typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(cookie.name)
      || typeof cookie.value !== 'string' || /[^\x20-\x7e]|;/.test(cookie.value) || cookie.value.length > 50000
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || !pathMatch(OZON_JSON_PATH,cookie.path)
      || typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean'
      || cookie.sameSite !== undefined && !['strict','lax','none'].includes(cookie.sameSite)
      || cookie.expires !== undefined && !Number.isFinite(cookie.expires)
      || cookie.name.startsWith('__Secure-') && !cookie.secure
      || cookie.name.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')) throw new Error('Invalid browser session');
    if (cookie.expires !== undefined && cookie.expires*1000 <= now) return [];
    return [{name:cookie.name,value:cookie.value,path:cookie.path,secure:cookie.secure,httpOnly:cookie.httpOnly,
      ...(cookie.hostOnly ? {url:'https://'+cookie.domain+'/'} : {domain:'.'+cookie.domain}),
      ...(cookie.sameSite ? {sameSite:cookie.sameSite[0].toUpperCase()+cookie.sameSite.slice(1)} : {}),
      ...(cookie.expires !== undefined ? {expires:cookie.expires} : {})}];
  });
}

// Navigate once, then use the same authenticated page for the rest of the queue.
export async function createBrowserReader(call, captured, {pause = ms => new Promise(resolve => setTimeout(resolve,ms))} = {}) {
  const request = validateCapturedRequest(captured);
  if (!['product','favorites','cart'].includes(request.operation)) throw new Error('Unsupported recovery target');
  const page = new URL(request.url).searchParams.get('url');
  const version = await call('Browser.getVersion');
  const {targetId} = await call('Target.createTarget',{url:'about:blank'});
  const {sessionId} = await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},sessionId);
  await call('Page.navigate',{url:'https://www.ozon.ru'+page},sessionId);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await pause(500);
    const result = await call('Runtime.evaluate',{expression:'({origin:location.origin,path:location.pathname,ready:document.readyState})',returnByValue:true},sessionId);
    const value = result.result?.value;
    let samePage = value?.path?.replace(/\/$/,'') === page.split('?')[0].replace(/\/$/,'');
    if (request.operation === 'product' && value?.origin === 'https://www.ozon.ru') {
      try {samePage = ozonProduct(value.origin+value.path).external_id === request.external_id;} catch {samePage = false;}
    }
    if (value?.origin === 'https://www.ozon.ru' && samePage && value.ready === 'complete') {ready = true;break;}
  }
  if (!ready) throw new Error('Browser not ready');
  let reads = 0, lastProduct = null;
  return {
    async read(captured) {
      const request = validateCapturedRequest(captured);
      if (++reads > 220 || !['product','favorites','cart','banks'].includes(request.operation)
        || request.operation === 'banks' && request.external_id !== lastProduct) throw new Error('Unsupported browser read');
      // Fixed read-only script. No page scripts or account actions come from callers.
      const expression = `(async()=>{try{
        const r=await fetch(${JSON.stringify(request.url)},{credentials:"include",redirect:"error",headers:{accept:"application/json"},signal:AbortSignal.timeout(15000)});
        const retry=r.headers.get("retry-after"),seconds=Number(retry);
        const retry_after_ms=!retry?0:Number.isFinite(seconds)&&seconds>=0?seconds*1000:Math.max(0,Date.parse(retry)-Date.now())||0;
        const summary={http_status:r.status,retry_after_ms,outcome:r.status===401?"login_required":r.status===403?"access_limited":r.status===429?"rate_limited":"http_error"};
        if(r.status!==200){await r.body?.cancel();return summary;}
        if(!/^application\\/(?:[a-z0-9.+-]+\\+)?json(?:\\s*;|$)/i.test(r.headers.get("content-type")||"")){await r.body?.cancel();return {...summary,outcome:"unexpected_content"};}
        const reader=r.body.getReader();let size=0,parts=[];
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8388608){await reader.cancel();return {...summary,outcome:"response_too_large"};}parts.push(value);}
        let bytes=new Uint8Array(size),offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
        const data=JSON.parse(new TextDecoder().decode(bytes));
        if(!data||typeof data!=="object"||Array.isArray(data))return {...summary,outcome:"unexpected_content"};
        return {...summary,outcome:"json_received",data};
      }catch{return {http_status:null,retry_after_ms:0,outcome:"network_error"};}})()`;
      const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
      const value = result.result?.value;
      if (result.exceptionDetails || !value || typeof value !== 'object') throw new Error('Browser read failed');
      if (request.operation === 'product' && value.outcome === 'json_received') lastProduct = request.external_id;
      return {...value,version:2,request_url:request.url,user_agent:version.userAgent};
    },
  };
}
