import {OzonReadError} from './client.js';
import {rublePrice} from './parser.js';
import {accountMatches} from './account-context.js';
import {ozonProduct,OZON_ORIGIN} from './url.js';
import {OZON_JSON_PATH} from './session.js';
import {readBounded,retryAfterMs} from './probe.js';

function checkedAddress(value,previous,sku) {
  if(typeof value!=='string' || /[\s\\]/.test(value))throw new OzonReadError('invalid_data');
  const target=new URL(value,previous);
  if(target.origin!==OZON_ORIGIN || target.pathname!==OZON_JSON_PATH || target.username || target.password || target.hash
    || target.searchParams.getAll('url').length!==1 || [...target.searchParams.keys()].some(key=>!['url','__rr','page_changed'].includes(key))
    || target.searchParams.has('page_changed') && (target.searchParams.getAll('page_changed').length!==1 || target.searchParams.get('page_changed')!=='true')
    || target.searchParams.has('__rr') && !/^[12]$/.test(target.searchParams.get('__rr')))throw new OzonReadError('invalid_data');
  const page=new URL(target.searchParams.get('url'),OZON_ORIGIN);
  if(page.origin!==OZON_ORIGIN || page.username || page.password || page.hash)throw new OzonReadError('invalid_data');
  if(page.pathname==='/search/' || page.pathname==='/search') {
    if(page.searchParams.getAll('product_id').length!==1 || page.searchParams.get('product_id')!==sku)throw new OzonReadError('invalid_data');
  }else if(ozonProduct(page.href).external_id!==sku)throw new OzonReadError('invalid_data');
  return target.href;
}

function widgetValues(data,prefix) {
  return Object.entries(data.widgetStates||{}).filter(([key])=>key.startsWith(prefix+'-')).map(([key,raw])=>({key,value:typeof raw==='string'?JSON.parse(raw):raw}));
}

export function unavailablePriceFields(data,sku) {
  const matches=widgetValues(data,'webOutOfStock').filter(({value})=>{
    try{return ozonProduct(new URL(value.common?.action?.link,OZON_ORIGIN).href).external_id===sku;}catch{return false;}
  });
  if(matches.length>1)throw new OzonReadError('invalid_data');
  if(matches.length===1) {
    const {key,value}=matches[0];
    if(value.price?.priceStyle?.styleType!=='UNAVAILABLE')throw new OzonReadError('invalid_data');
    const prices=Array.isArray(value.price.price)?value.price.price:[];
    const price=rublePrice(prices.find(part=>part.textStyle==='PRICE')?.text);
    if(price!==null)return {listed_price_kopecks:price,
      original_price_kopecks:rublePrice(prices.find(part=>part.textStyle==='ORIGINAL_PRICE')?.text),
      availability:'out_of_stock',field:'webOutOfStock.price.price[].text',widget:key};
  }
  const identities=widgetValues(data,'webDetailSKU');
  const prices=widgetValues(data,'webPrice');
  if(identities.length===1 && String(identities[0].value.copyText)===sku && prices.length===1) {
    const value=prices[0].value,price=rublePrice(value.price);
    if(price!==null && typeof value.isAvailable==='boolean')return {listed_price_kopecks:price,
      original_price_kopecks:rublePrice(value.originalPrice),availability:value.isAvailable?'available':'out_of_stock',
      field:'webPrice.price',widget:prices[0].key};
  }
  return null;
}

// Only this SKU's product page and its observed out-of-stock search redirect.
// Recommendation tiles never supply the original product's price.
export async function readUnavailablePrice(client,product,{trace=[],signal}={}) {
  const sku=String(product.sku),request=client.request(new URL(product.url).pathname),visited=new Set();
  if(request.external_id!==sku)throw new OzonReadError('invalid_data');
  let address=request.url;
  for(let hop=0;hop<4;hop++) {
    address=checkedAddress(address,address,sku);
    if(visited.has(address))throw new OzonReadError('redirect');visited.add(address);
    const timeout=AbortSignal.timeout(20000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
    const response=await client.fetchImpl(address,{method:'GET',headers:{...request.headers,accept:'application/json',cookie:await client.session.header(address)},redirect:'manual',signal:requestSignal});
    trace.push({sku,status:response.status});
    const retry=retryAfterMs(response.headers.get('retry-after'));
    await client.session.absorb(response.headers,address);
    if(retry>0 || response.status===429){await response.body?.cancel();throw new OzonReadError('rate_limited',retry);}
    if(response.status>=300 && response.status<400) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(![301,302,303,307,308].includes(response.status) || !location)throw new OzonReadError('redirect');
      address=checkedAddress(location,address,sku);continue;
    }
    if(response.status!==200){await response.body?.cancel();throw new OzonReadError(response.status===401?'login_required':response.status===403?'access_limited':'http_error');}
    if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new OzonReadError('unexpected_content');}
    const payload=await readBounded(response,8*1024*1024);
    if(payload.too_large)throw new OzonReadError('response_too_large');
    const data=JSON.parse(payload.body);
    if(!accountMatches(data,client.connection.reference,{requireLoginFlag:true}))throw new OzonReadError(data?.userInfo?.user?.isLoggedIn===false?'login_required':'context_mismatch');
    return {price:unavailablePriceFields(data,sku),data};
  }
  throw new OzonReadError('redirect');
}
