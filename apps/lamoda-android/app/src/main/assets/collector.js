// Executed only in the current Lamoda top-level page. No native JS bridge or device credentials.
globalThis.__priceCheckerReadPage = async function(page) {
  if (!['https://lamoda.ru','https://www.lamoda.ru'].includes(location.origin)
    || !Number.isSafeInteger(page) || page<1 || page>1000) return {error:'invalid_data'};
  globalThis.__priceCheckerCancel?.();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  globalThis.__priceCheckerCancel = cancel;
  let timedOut=false,httpStatus=0,reason='request_failed';
  const failure=(error,source_reason)=>({error,source_reason,http_status:httpStatus});
  const timeout = setTimeout(()=>{timedOut=true;cancel();},45000);
  try {
    // Manual redirects expose only an opaque response, never the destination or its body.
    const response = await fetch('/wishlist/?page='+page,{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal});
    if (response.type==='opaqueredirect') return failure('account_unverified','redirect');
    httpStatus=response.status;
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const retryMs = !retry ? 0 : /^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now()) || 0;
      return {...failure(response.status===429 ? 'rate_limited' : 'access_limited','http_error'),retry_after_ms:Math.min(retryMs,365*86400000)};
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) return failure('account_unverified','content_type');
    reason='response_read';
    const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,html='';
    while (true) {
      const part=await reader.read();if (part.done) break;size+=part.value.length;
      if (size>12*1024*1024) {await reader.cancel();return failure('invalid_data','response_too_large');}
      html+=decoder.decode(part.value,{stream:true});
    }
    html+=decoder.decode();
    reason='html_parse';
    const document=new DOMParser().parseFromString(html,'text/html');
    const scripts=[...document.scripts].map(script=>script.textContent).filter(text=>/^\s*var\s+__NUXT__\s*=/.test(text));
    if (scripts.length!==1) return failure('account_unverified',scripts.length===0?'state_script_missing':'state_script_ambiguous');
    const read=key=>{
      reason=key==='user'?'user_state':'payload_state';
      const lines=scripts[0].split('\n').filter(line=>new RegExp('^ {8}'+key+':').test(line));
      if (lines.length!==1) throw Error('Unrecognized response');
      return JSON.parse(lines[0].replace(new RegExp('^ {8}'+key+':\\s*'),'').replace(/,\s*$/,''));
    };
    const user=read('user');
    if (!user || typeof user!=='object' || !Object.hasOwn(user,'customer')) return failure('account_unverified','customer_missing');
    if (user.customer===null) return failure('login_required','customer_null');
    const payload=read('payload');
    reason='state_shape';
    // Transmit only fields needed by the server parser; exclude profile, addresses, cookies and unrelated state.
    const products=Array.isArray(payload?.products) ? payload.products.map(product=>Object.fromEntries(
      ['sku','name','price_iso_code','seo_tail','prices','price_amount','old_price_amount','is_available','is_sellable','thumbnail','color_family','is_hybrid','hybrid_products']
        .filter(key=>Object.hasOwn(product,key)).map(key=>[key,product[key]]).concat([['brand',{name:product.brand?.name}]]))) : null;
    const result={user:{customer:user?.customer ? {id:user.customer.id,is_active:user.customer.is_active} : null,
      wishlist:user?.wishlist?.map(item=>({product_sku:item.product_sku,...(item.adjacent_skus == null ? {} : {adjacent_skus:item.adjacent_skus})}))},payload:{pagination:payload?.pagination,products}};
    if (new TextEncoder().encode(JSON.stringify(result)).length>1900000) return failure('invalid_data','state_too_large');
    return result;
  } catch {return failure(controller.signal.aborted ? 'interrupted' : 'account_unverified',timedOut?'request_timeout':controller.signal.aborted?'read_canceled':reason);}
  finally {
    clearTimeout(timeout);
    if (globalThis.__priceCheckerCancel === cancel) delete globalThis.__priceCheckerCancel;
  }
};
