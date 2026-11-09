// Executed only in the current Lamoda top-level page. No native JS bridge or device credentials.
globalThis.__priceCheckerReadPage = function(page) {
  if (!['https://lamoda.ru','https://www.lamoda.ru'].includes(location.origin)
    || !Number.isSafeInteger(page) || page<1 || page>1000) return {error:'invalid_data'};
  // Native code navigates afresh. A separate fetch can receive an inert site
  // challenge even while the displayed wishlist is authenticated.
  const address=new URL(location.href),pages=address.searchParams.getAll('page');
  if (!['/wishlist/','/wishlist'].includes(address.pathname)
    || [...address.searchParams.keys()].some(key=>key!=='page')
    || !(pages.length===0 && page===1 || pages.length===1 && pages[0]===String(page)))
    return {pending:true,source_reason:'page_navigation'};
  if (document.readyState!=='complete') return {pending:true};
  let reason='user_state';
  const failure=(error,source_reason)=>({error,source_reason});
  try {
    const scripts=[...document.scripts].map(script=>script.textContent).filter(text=>/^\s*var\s+__NUXT__\s*=/.test(text));
    // A challenge can navigate after onPageFinished. Native code polls under
    // one deadline rather than classifying missing state as a logout.
    if (scripts.length===0) return {pending:true,source_reason:'state_script_missing'};
    if (scripts.length!==1) return failure('account_unverified','state_script_ambiguous');
    if (new TextEncoder().encode(scripts[0]).length>12*1024*1024) return failure('invalid_data','response_too_large');
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
    if (payload?.pagination?.page!==page) return failure('incomplete_data','state_shape');
    // Transmit only fields needed by the server parser; exclude profile, addresses, cookies and unrelated state.
    const products=Array.isArray(payload?.products) ? payload.products.map(product=>Object.fromEntries(
      ['sku','name','price_iso_code','seo_tail','prices','price_amount','old_price_amount','is_available','is_sellable','thumbnail','color_family','is_hybrid','hybrid_products']
        .filter(key=>Object.hasOwn(product,key)).map(key=>[key,key==='prices' && Array.isArray(product.prices)
          ? product.prices.map(entry=>({price:entry?.price})) : product[key]]).concat([['brand',{name:product.brand?.name}]]))) : null;
    const pagination=payload?.pagination;
    const result={user:{customer:user?.customer ? {id:user.customer.id,is_active:user.customer.is_active} : null,
      wishlist:user?.wishlist?.map(item=>({product_sku:item.product_sku,...(item.adjacent_skus == null ? {} : {adjacent_skus:item.adjacent_skus})}))},
      payload:{pagination:pagination && Object.fromEntries(['found','limit','offset','page','pages'].map(key=>[key,pagination[key]])),products}};
    if (new TextEncoder().encode(JSON.stringify(result)).length>1900000) return failure('invalid_data','state_too_large');
    return result;
  } catch {return failure('account_unverified',reason);}
};
