import {QueryClient, queryOptions} from '@tanstack/react-query';
import type {DashboardData, DetailData, ListId, Period, PriceContext, Status} from './types';

export const queryClient = new QueryClient({defaultOptions: {queries: {retry: 1, staleTime: 1000}, mutations: {retry: false}}});

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос');
  return result as T;
}

export const statusOptions = queryOptions({
  queryKey: ['status'],
  queryFn: ({signal}) => request<Status>('/api/status', {signal}),
  refetchInterval: query => query.state.data?.running ? 1000 : 15000,
});
export const dashboardOptions = (list: ListId, context: PriceContext) => queryOptions({
  queryKey: ['dashboard', list, context],
  queryFn: ({signal}) => request<DashboardData>(`/api/dashboard?list=${list}&context=${context}`, {signal}),
});
export const detailOptions = (id: number | null, context: PriceContext, days: Period) => queryOptions({
  queryKey: ['detail', id, context, days],
  queryFn: ({signal}) => request<DetailData>(`/api/product/${id}?context=${context}&days=${days}`, {signal}),
  enabled: id !== null,
});

export async function mutate<T = {ok: boolean}>(path: string, data: unknown): Promise<T> {
  // Read the token at mutation time; a server restart must not strand an old token in a store.
  const status = await queryClient.fetchQuery({...statusOptions, staleTime: 0});
  return request<T>(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf_token || ''}, body: JSON.stringify(data)});
}
export async function invalidatePrices() {
  await Promise.all([
    queryClient.invalidateQueries({queryKey: ['status']}),
    queryClient.invalidateQueries({queryKey: ['dashboard']}),
    queryClient.invalidateQueries({queryKey: ['detail']}),
  ]);
}
