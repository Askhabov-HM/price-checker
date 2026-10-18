import {afterEach, expect, it, vi} from 'vitest';
import {logout, mutate, queryClient} from './api';

afterEach(() => {queryClient.clear(); vi.unstubAllGlobals();});
it('obtains the current CSRF token before a mutation and preserves API errors', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({csrf_token: 'test-token'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({error: 'Проверка уже выполняется'}), {status: 409}));
  vi.stubGlobal('fetch', fetch);
  await expect(mutate('/api/refresh', {})).rejects.toThrow('Проверка уже выполняется');
  expect(fetch.mock.calls[0][0]).toBe('/api/status');
  expect(fetch.mock.calls[1][1]).toMatchObject({method: 'POST', headers: {'X-CSRF-Token': 'test-token'}});
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('signing out removes private Ozon data along with Randewoo caches', async () => {
  queryClient.setQueryData(['ozon','dashboard','watching'],{private:'synthetic-products'});
  queryClient.setQueryData(['dashboard','cart','public'],{private:'synthetic-randewoo'});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({csrf_token:'test-token'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({required:true,authenticated:false,login:null,csrf_token:'signed-out'}))));
  await logout();
  expect(queryClient.getQueryData(['ozon','dashboard','watching'])).toBeUndefined();
  expect(queryClient.getQueryData(['dashboard','cart','public'])).toBeUndefined();
});
