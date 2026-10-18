import {validateCapturedRequest} from './network-capture.js';

// Browser page traffic is natural; only one navigation and one explicit API read.
export async function refreshBrowser(call, captured, {pause = ms => new Promise(resolve => setTimeout(resolve,ms))} = {}) {
  const request = validateCapturedRequest(captured);
  if (!['product','favorites','cart'].includes(request.operation)) throw new Error('Unsupported recovery target');
  const page = request.operation === 'product' ? '/product/'+request.external_id+'/'
    : request.operation === 'favorites' ? '/my/favorites?sorting=last_added' : '/cart';
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
    if (value?.origin === 'https://www.ozon.ru' && value.path.replace(/\/$/,'') === page.split('?')[0].replace(/\/$/,'') && value.ready === 'complete') {ready = true; break;}
  }
  if (!ready) throw new Error('Browser not ready');
  // Bound the body inside Chrome too; never return an unbounded response over CDP.
  const expression = '(async()=>{const r=await fetch('+JSON.stringify(request.url)+', {credentials:"include",redirect:"error",headers:{accept:"application/json"},signal:AbortSignal.timeout(15000)});'
    +'if(r.status!==200)throw Error("Read failed");const reader=r.body.getReader();let size=0,parts=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8388608){await reader.cancel();throw Error("Too large");}parts.push(value);}let bytes=new Uint8Array(size),offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder().decode(bytes));})()';
  const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
  const data = result.result?.value;
  if (result.exceptionDetails || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Browser read failed');
  const cookies = (await call('Storage.getCookies')).cookies.filter(cookie => ['.ozon.ru','ozon.ru','www.ozon.ru'].includes(cookie.domain));
  return {version:1,request_url:request.url,user_agent:version.userAgent,data,cookies};
}
