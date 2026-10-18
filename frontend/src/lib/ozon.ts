import {queryOptions} from '@tanstack/react-query';
import {authOptions, queryClient, request} from './api';
import type {Check} from './types';

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
}
export interface OzonPoint {
  checked_at: string; status: 'ok' | 'error'; availability: string;
  regular_kopecks: number | null; ozon_card_kopecks: number | null; seller_id: string | null;
  seller_name: string | null; message: string; source: 'http' | 'browser';
}
export interface OzonDashboard {items: OzonItem[]; counts: Record<OzonList, number>; list: OzonList; status: OzonStatus;}
export interface OzonDetail {product: OzonItem; points: OzonPoint[]; seller_events: SellerEvent[];}

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
