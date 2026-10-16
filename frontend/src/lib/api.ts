import {QueryClient, queryOptions} from '@tanstack/react-query';
import type {AuthState, DashboardData, DetailData, ListId, Period, PriceContext, Status} from './types';

export const queryClient = new QueryClient({defaultOptions: {queries: {retry: 1, staleTime: 1000}, mutations: {retry: false}}});

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  const result = await response.json();
  if (response.status === 401 && path !== '/api/login') {
    queryClient.setQueryData<AuthState>(['auth'], previous => ({required: true, authenticated: false, login: null, csrf_token: previous?.csrf_token || ''}));
    void clearPrivateQueries();
  }
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос');
  return result as T;
}

export const authOptions = queryOptions({
  queryKey: ['auth'],
  queryFn: ({signal}) => request<AuthState>('/api/auth', {signal}),
  retry: false,
  staleTime: 0,
  refetchInterval: 60000,
});

async function clearPrivateQueries() {
  for (const key of ['status', 'dashboard', 'detail']) {
    await queryClient.cancelQueries({queryKey: [key]});
    queryClient.removeQueries({queryKey: [key]});
  }
}

export async function login(login: string, password: string) {
  const state = await request<AuthState>('/api/auth');
  const authenticated = await request<AuthState>('/api/login', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf_token}, body: JSON.stringify({login, password})});
  await clearPrivateQueries();
  queryClient.setQueryData(['auth'], authenticated);
}

export async function logout() {
  const state = await mutate<AuthState>('/api/logout', {});
  queryClient.setQueryData(['auth'], state);
  await clearPrivateQueries();
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
