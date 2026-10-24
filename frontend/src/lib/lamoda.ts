import {queryOptions} from '@tanstack/react-query';
import {authOptions,queryClient,request} from './api';
import type {Check,Filter,Sort,ChangePeriod,ScheduleSettings,PriceChangeEvent,PricePoint,CollectionStatus} from './types';
import {hasRecentChange} from './price-changes';

export interface LamodaStatus extends ScheduleSettings, CollectionStatus {
  available:boolean; configured:boolean; running:boolean; next_check:string|null; not_before:string|null;
  action_required:boolean; message:string; checks:Check[];
  login:{available:boolean;active:boolean;required:boolean;expires_at:string|null};
  desktop?:{enabled:boolean;device:{name:string;last_seen:string|null}|null;not_before:string|null;
    latest:{run_id:string;received_at:string;item_count:number}|null;
    schedule:{enabled:boolean;interval_minutes:3;next_check:string|null;action_required:boolean;last_error:string|null};
    job:{id:string;status:'queued'|'active';expires_at:string|null}|null};
  mobile?:{enabled:boolean;device:{name:string;last_seen:string|null}|null;job:{id:string;expires:number;next_page:number}|null;
    push?:{configured:boolean;enabled:boolean;registered_at:string|null;accepted_at:string|null;error:string|null}|null;
    diagnostics:{job_id:string;event:string;at:string;page:number|null;reason:string|null;screen_locked:number|null;screen_off:number|null}[]};
}
export interface LamodaPoint extends PricePoint {original_price:number|null;availability:string;price_at:string|null;}
export interface LamodaItem {
  id:string;sku:string;title:string;color:string;url:string;image_url:string|null;price:number|null;original_price:number|null;
  checked_at:string|null;price_at:string|null;status:'ok'|'error'|'pending';availability:string;message:string;
  minimum:number|null;observations:number;last_change:PriceChangeEvent|null;sparkline:LamodaPoint[];
}
export interface LamodaDashboard {items:LamodaItem[];history:(PricePoint&{count:number;priced_count:number;complete:boolean})[];status:LamodaStatus;}
export interface LamodaDetail {product:LamodaItem;points:LamodaPoint[];}
export interface DesktopDashboard {items:LamodaItem[];history:(PricePoint&{count:number;priced_count:number;complete:boolean})[];
  activity:{at:string;status:'success'|'error';count:number;run_id?:string;message?:string}[];}
export const lamodaStatusOptions = queryOptions({queryKey:['lamoda','status'],queryFn:({signal}) => request<LamodaStatus>('/api/providers/lamoda/status',{signal}),refetchInterval:q => q.state.data?.running ? 1000 : 15000});
export const lamodaDashboardOptions = queryOptions({queryKey:['lamoda','dashboard'],queryFn:({signal}) => request<LamodaDashboard>('/api/providers/lamoda/dashboard',{signal})});
export const lamodaDetailOptions = (id:string|null,days:number) => queryOptions({queryKey:['lamoda','detail',id,days],enabled:id!==null,
  queryFn:({signal}) => request<LamodaDetail>(`/api/providers/lamoda/product/${encodeURIComponent(id||'')}/history?days=${days}`,{signal})});
export const desktopDashboardOptions = queryOptions({queryKey:['lamoda','desktop','dashboard'],
  queryFn:({signal}) => request<DesktopDashboard>('/api/providers/lamoda/desktop/dashboard',{signal}),refetchInterval:30000});
export const desktopDetailOptions = (id:string|null,days:number) => queryOptions({queryKey:['lamoda','desktop','detail',id,days],enabled:id!==null,
  queryFn:({signal}) => request<LamodaDetail>(`/api/providers/lamoda/desktop/product/${encodeURIComponent(id||'')}/history?days=${days}`,{signal})});
export async function lamodaMutate<T = {ok:boolean}>(action:string,data:unknown = {}) {
  const auth = await queryClient.fetchQuery({...authOptions,staleTime:0});
  return request<T>('/api/providers/lamoda/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf_token},body:JSON.stringify(data)});
}
export const invalidateLamoda = () => queryClient.invalidateQueries({queryKey:['lamoda']});
export function selectLamoda(items:LamodaItem[],search:string,filter:Filter,sort:Sort,changeDays:ChangePeriod,now:number) {
  const recent = (item:LamodaItem) => hasRecentChange(item,changeDays,now);
  return items.filter(item => `${item.title} ${item.color} ${item.sku}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).filter(item => {
    return filter === 'all' || filter === 'changed' && recent(item) || filter === 'drops' && recent(item) && item.last_change!.delta < 0
      || filter === 'rises' && recent(item) && item.last_change!.delta > 0 || filter === 'unavailable' && item.availability === 'unavailable'
      || filter === 'errors' && (item.status !== 'ok' || item.availability !== 'unavailable' && item.price === null)
      || filter === 'minimum' && item.status === 'ok' && item.availability === 'available' && item.price !== null && item.price === item.minimum && item.observations > 1;
  }).sort((a,b) => {
    const name = () => a.title.localeCompare(b.title,'ru') || a.sku.localeCompare(b.sku);
    if (sort === 'price-asc') return (a.price ?? Infinity)-(b.price ?? Infinity) || name();
    if (sort === 'price-desc') return (b.price ?? -Infinity)-(a.price ?? -Infinity) || name();
    if (sort === 'delta') return (recent(a) ? a.last_change!.delta : Infinity)-(recent(b) ? b.last_change!.delta : Infinity) || name();
    if (sort === 'recent') return (Date.parse(b.last_change?.checked_at || '') || 0)-(Date.parse(a.last_change?.checked_at || '') || 0) || name();
    return name();
  });
}
