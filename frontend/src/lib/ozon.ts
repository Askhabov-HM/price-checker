import {queryOptions} from '@tanstack/react-query';
import {authOptions, queryClient, request} from './api';
import type {Check, PricePoint} from './types';

export type OzonList = 'watching' | 'favorites' | 'cart';
export type OzonPrice = 'ozon_card' | 'regular';
export interface OzonStatus {
  available: boolean; configured: boolean; running: boolean; schedule_enabled: boolean;
  interval_minutes: number; next_check: string | null; not_before: string | null;
  action_required: boolean; message: string; city: string; checks: Check[];
}
export interface SellerEvent {checked_at: string; old_name: string | null; new_name: string | null;}
export interface OzonItem {
  id: string; sku: string; url: string; title: string; image_url: string | null;
  regular_kopecks: number | null; ozon_card_kopecks: number | null; seller_id: string | null;
  seller_name: string | null; seller_change: SellerEvent | null; status: 'pending' | 'ok' | 'error';
  availability: string; checked_at: string | null; price_at: string | null; message: string;
  lists: {list: OzonList; quantity: number}[];
  sparkline: OzonChartPoint[];
}
export interface OzonChartPoint {
  checked_at: string; status: 'ok' | 'error'; availability: string;
  regular_kopecks: number | null; ozon_card_kopecks: number | null; seller_id: string | null;
  message: string;
}
export interface OzonPoint extends OzonChartPoint {
  seller_name: string | null; source: 'http' | 'browser';
}
export interface OzonTotal {known_total: number; priced_count: number; complete: boolean; status: 'ok' | 'error' | 'missing'; composition: string;}
export interface OzonHistory {checked_at: string; count: number; observed_count: number; message: string; regular: OzonTotal; ozon_card: OzonTotal;}
export interface OzonDashboard {items: OzonItem[]; counts: Record<OzonList, number>; list: OzonList; status: OzonStatus; history: OzonHistory[];}
export interface OzonDetail {product: OzonItem; points: OzonPoint[]; seller_events: SellerEvent[];}

export function ozonProductPoints(points: OzonChartPoint[], price: OzonPrice): PricePoint[] {
  return points.map(point => ({...point,price:price === 'regular' ? point.regular_kopecks : point.ozon_card_kopecks,
    composition:point.seller_id || 'unknown',in_stock:point.availability === 'available'}));
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
export async function invalidateOzon() {await queryClient.invalidateQueries({queryKey:['ozon']});}
