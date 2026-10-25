import {queryOptions} from '@tanstack/react-query';
import {authOptions, queryClient, request} from './api';
import type {ChangePeriod, Check, Filter, PriceChangeEvent, PricePoint, ScheduleSettings, Sort, CollectionStatus} from './types';
import {hasRecentChange} from './price-changes';
import {mutationRefetch,settledRevision} from './collection-state';

export type OzonList = 'watching' | 'favorites' | 'cart';
export type OzonPrice = 'listed' | 'ozon_card' | 'regular';
export interface OzonStatus extends CollectionStatus {
  available: boolean; configured: boolean; running: boolean; schedule_enabled: boolean;
  interval_minutes: ScheduleSettings['interval_minutes']; next_check: string | null; not_before: string | null;
  schedule_mode?: ScheduleSettings['schedule_mode']; schedule?: string[];
  action_required: boolean; message: string; checks: Check[];
  login?: {available: boolean; required: boolean; active: boolean; expires_at: string | null; phone_hint: string | null};
}
export interface SellerEvent {checked_at: string; old_name: string | null; new_name: string | null;}
export interface OzonItem {
  id: string; sku: string; url: string; title: string; image_url: string | null;
  listed_price_kopecks: number | null; regular_kopecks: number | null; ozon_card_kopecks: number | null; seller_id: string | null;
  original_price_kopecks: number | null;
  seller_name: string | null; seller_change: SellerEvent | null; status: 'pending' | 'ok' | 'error';
  availability: string; checked_at: string | null; price_at: string | null; message: string;
  lists: {list: OzonList; quantity: number}[];
  sparkline: OzonChartPoint[];
  price_summary?: Record<OzonPrice, {minimum: number | null; observations: number; last_change: PriceChangeEvent | null}>;
}
export interface OzonChartPoint {
  checked_at: string; status: 'ok' | 'error'; availability: string;
  listed_price_kopecks: number | null; regular_kopecks: number | null; ozon_card_kopecks: number | null; seller_id: string | null;
  message: string;
}
export interface OzonPoint extends OzonChartPoint {
  original_price_kopecks: number | null;
  seller_name: string | null; source: 'http' | 'browser';
}
export interface OzonTotal {known_total: number; priced_count: number; complete: boolean; status: 'ok' | 'error' | 'missing'; composition: string;}
export interface OzonHistory {checked_at: string; count: number; observed_count: number; message: string; listed: OzonTotal; regular: OzonTotal; ozon_card: OzonTotal;}
export interface OzonDashboard {items: OzonItem[]; counts: Record<OzonList, number>; list: OzonList; status: OzonStatus; history: OzonHistory[];}
export interface OzonDetail {product: OzonItem; points: OzonPoint[]; seller_events: SellerEvent[];}

export function ozonPrice(point: Pick<OzonChartPoint,'listed_price_kopecks' | 'regular_kopecks' | 'ozon_card_kopecks'>, price: OzonPrice) {
  return price === 'listed' ? point.listed_price_kopecks : price === 'regular' ? point.regular_kopecks : point.ozon_card_kopecks;
}
export function ozonUnavailable(item: Pick<OzonChartPoint, 'availability'>) {
  return ['out_of_stock', 'unavailable'].includes(item.availability);
}
export function selectOzonProducts(items: OzonItem[], query: string, filter: Filter, sort: Sort, price: OzonPrice, changeDays: ChangePeriod, nowMs: number) {
  const search = query.toLocaleLowerCase('ru');
  const change = (item: OzonItem) => item.price_summary?.[price].last_change ?? null;
  const recent = (item: OzonItem) => hasRecentChange({last_change:change(item)}, changeDays, nowMs);
  const visible = items.filter(item => `${item.title} ${item.sku}`.toLocaleLowerCase('ru').includes(search)).filter(item => {
    const summary = item.price_summary?.[price], current = ozonPrice(item,price);
    return filter === 'all' || filter === 'changed' && recent(item)
      || filter === 'drops' && recent(item) && change(item)!.delta < 0
      || filter === 'rises' && recent(item) && change(item)!.delta > 0
      || filter === 'minimum' && item.status === 'ok' && !ozonUnavailable(item) && current != null && !!summary && current === summary.minimum && summary.observations > 1
      || filter === 'unavailable' && ozonUnavailable(item)
      || filter === 'errors' && (['error','pending'].includes(item.status) || !ozonUnavailable(item) && current == null);
  });
  const byName = (a: OzonItem, b: OzonItem) => a.title.localeCompare(b.title,'ru') || a.sku.localeCompare(b.sku);
  return visible.sort((a,b) => {
    if (sort === 'price-asc') return (ozonPrice(a,price) ?? Infinity) - (ozonPrice(b,price) ?? Infinity) || byName(a,b);
    if (sort === 'price-desc') return (ozonPrice(b,price) ?? -Infinity) - (ozonPrice(a,price) ?? -Infinity) || byName(a,b);
    if (sort === 'delta') return (recent(a) ? change(a)!.delta : Infinity) - (recent(b) ? change(b)!.delta : Infinity) || byName(a,b);
    if (sort === 'recent') return (change(b) ? Date.parse(change(b)!.checked_at) : -Infinity) - (change(a) ? Date.parse(change(a)!.checked_at) : -Infinity) || byName(a,b);
    return byName(a,b);
  });
}
export function ozonProductPoints(points: OzonChartPoint[], price: OzonPrice): PricePoint[] {
  return points.map(point => ({...point,price:ozonPrice(point,price),
    composition:price === 'listed' ? 'favorites' : point.seller_id || 'unknown',
    in_stock:point.availability === 'unknown' ? null : point.availability === 'available'}));
}
export function ozonOverviewPoints(history: OzonHistory[], price: OzonPrice) {
  return history.map(point => ({...point,...point[price],price:point[price].priced_count ? point[price].known_total : null}));
}

export const ozonStatusOptions = queryOptions({queryKey:['ozon','status'],queryFn:({signal}) => request<OzonStatus>('/api/providers/ozon/status',{signal}),
  refetchInterval:query => query.state.data?.running ? 1000 : 15000});
export const ozonDashboardOptions = (list: OzonList) => queryOptions({queryKey:['ozon','dashboard',list],
  queryFn:({signal}) => request<OzonDashboard>(`/api/providers/ozon/dashboard?list=${list}`,{signal})});
export const ozonDetailOptions = (id: string | null, days: number) => queryOptions({queryKey:['ozon','detail',id,days],enabled:id !== null,
  queryFn:({signal}) => request<OzonDetail>(`/api/providers/ozon/product/${encodeURIComponent(id || '')}/history?days=${days}`,{signal})});
export async function ozonMutate<T = {ok: boolean}>(action: string, data: unknown): Promise<T> {
  const auth = await queryClient.fetchQuery({...authOptions,staleTime:0});
  return request<T>('/api/providers/ozon/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf_token},body:JSON.stringify(data)});
}
export async function invalidateOzon() {
  const before = settledRevision(queryClient.getQueryData<OzonStatus>(['ozon','status']));
  await queryClient.invalidateQueries({queryKey:['ozon','status']});
  const status = queryClient.getQueryData<OzonStatus>(['ozon','status']);
  const refetchType = mutationRefetch(status?.running,before,settledRevision(status));
  await Promise.all(['dashboard','detail'].map(part => queryClient.invalidateQueries({queryKey:['ozon',part],refetchType})));
}
