import {createRootRoute, createRoute, createRouter, Link, notFound, redirect} from '@tanstack/react-router';
import {AppShell} from '@/components/app-shell';
import {Dashboard} from '@/pages/dashboard';
import type {Filter, Period, PriceContext, Sort} from '@/lib/types';

export function validateSearch(search: Record<string, unknown>) {
  return {
    context: (search.context === 'cart' ? 'cart' : 'public') as PriceContext,
    q: typeof search.q === 'string' ? search.q : '',
    filter: (['all', 'drops', 'rises', 'minimum', 'unavailable', 'errors'].includes(String(search.filter)) ? search.filter : 'all') as Filter,
    sort: (['name', 'price-asc', 'price-desc', 'delta'].includes(String(search.sort)) ? search.sort : 'name') as Sort,
    days: ([0, 7, 30, 90].includes(Number(search.days)) ? Number(search.days) : 30) as Period,
  };
}
const root = createRootRoute({component: AppShell, validateSearch, notFoundComponent: () => <div className="p-8"><h1>Страница не найдена</h1><Link to="/$listId" params={{listId: 'cart'}} search={validateSearch({})}>Открыть корзину</Link></div>});
const index = createRoute({getParentRoute: () => root, path: '/', beforeLoad: ({search}) => {throw redirect({to: '/$listId', params: {listId: 'cart'}, search});}});
const list = createRoute({getParentRoute: () => root, path: '/$listId', beforeLoad: ({params}) => {if (!['cart', 'favorites', 'watching'].includes(params.listId)) throw notFound();}, component: Dashboard});
export const router = createRouter({routeTree: root.addChildren([index, list])});
declare module '@tanstack/react-router' {interface Register {router: typeof router;}}
