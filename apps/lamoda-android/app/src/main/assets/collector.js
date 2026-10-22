// Executed only in the current Lamoda top-level page. No native JS bridge or device credentials.
globalThis.__priceCheckerReadPage = async function(page) {
  if (!['https://lamoda.ru','https://www.lamoda.ru'].includes(location.origin)
    || !Number.isSafeInteger(page) || page<1 || page>1000) return {error:'invalid_data'};
  try {
    const response = await fetch('/wishlist/?page='+page,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const retryMs = !retry ? 0 : /^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now()) || 0;
      return {error:response.status===429 ? 'rate_limited' : 'access_limited',http_status:response.status,retry_after_ms:Math.min(retryMs,365*86400000)};
    }
    if (!response.headers.get('content-type')?.includes('text/html')) return {error:'account_unverified'};
    const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,html='';
    while (true) {
      const part=await reader.read();if (part.done) break;size+=part.value.length;
      if (size>12*1024*1024) {await reader.cancel();return {error:'invalid_data'};}
      html+=decoder.decode(part.value,{stream:true});
    }
    html+=decoder.decode();
    const document=new DOMParser().parseFromString(html,'text/html');
    const scripts=[...document.scripts].map(script=>script.textContent).filter(text=>/^\s*var\s+__NUXT__\s*=/.test(text));
    if (scripts.length!==1) return {error:'account_unverified'};
    const read=key=>{
      const lines=scripts[0].split('\n').filter(line=>new RegExp('^ {8}'+key+':').test(line));
      if (lines.length!==1) throw Error('Unrecognized response');
      return JSON.parse(lines[0].replace(new RegExp('^ {8}'+key+':\\s*'),'').replace(/,\s*$/,''));
    };
    const user=read('user');
    if (!user || typeof user!=='object' || !Object.hasOwn(user,'customer')) return {error:'account_unverified'};
    if (user.customer===null) return {error:'login_required'};
    const payload=read('payload');
    // Transmit only fields needed by the server parser; exclude profile, addresses, cookies and unrelated state.
    const products=Array.isArray(payload?.products) ? payload.products.map(product=>Object.fromEntries(
      ['sku','name','price_iso_code','seo_tail','prices','price_amount','old_price_amount','is_available','is_sellable','thumbnail','color_family']
        .filter(key=>Object.hasOwn(product,key)).map(key=>[key,product[key]]).concat([['brand',{name:product.brand?.name}]]))) : null;
    const result={user:{customer:user?.customer ? {id:user.customer.id,is_active:user.customer.is_active} : null,
      wishlist:user?.wishlist?.map(item=>({product_sku:item.product_sku}))},payload:{pagination:payload?.pagination,products}};
    if (new TextEncoder().encode(JSON.stringify(result)).length>1900000) return {error:'invalid_data'};
    return result;
  } catch {return {error:'account_unverified'};}
};
