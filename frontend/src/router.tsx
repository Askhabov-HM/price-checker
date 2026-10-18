import {createRootRoute, createRoute, createRouter, Link, notFound, redirect} from '@tanstack/react-router';
import {AppShell} from '@/components/app-shell';
import {AuthGate} from '@/components/auth-gate';
import {Dashboard} from '@/pages/dashboard';
import {OzonDashboard} from '@/pages/ozon';
import {listIds} from '@/lib/format';
import type {ChangePeriod, Filter, Period, PriceContext, Sort} from '@/lib/types';

function validateSearch(search: Record<string, unknown>) {
  return {
    context: (search.context === 'cart' ? 'cart' : 'public') as PriceContext,
    q: typeof search.q === 'string' ? search.q : '',
    filter: (['all', 'changed', 'drops', 'rises', 'minimum', 'unavailable', 'errors'].includes(String(search.filter)) ? search.filter : 'all') as Filter,
    sort: (['recent', 'name', 'price-asc', 'price-desc', 'delta'].includes(String(search.sort)) ? search.sort : 'recent') as Sort,
    changeDays: ([7, 14, 30].includes(Number(search.changeDays)) ? Number(search.changeDays) : 7) as ChangePeriod,
    days: ([0, 7, 30, 90].includes(Number(search.days)) ? Number(search.days) : 30) as Period,
  };
}
const root = createRootRoute({component: () => <AuthGate><AppShell /></AuthGate>, validateSearch, notFoundComponent: () => <div className="p-8"><h1>Страница не найдена</h1><Link to="/$listId" params={{listId: 'cart'}} search={validateSearch({})}>Открыть корзину</Link></div>});
const index = createRoute({getParentRoute: () => root, path: '/', beforeLoad: ({search}) => {throw redirect({to: '/$listId', params: {listId: 'cart'}, search});}});
const list = createRoute({getParentRoute: () => root, path: '/$listId', beforeLoad: ({params}) => {if (!listIds.some(id => id === params.listId)) throw notFound();}, component: Dashboard});
const ozon = createRoute({getParentRoute:() => root,path:'/ozon',component:OzonDashboard,validateSearch:(search: Record<string, unknown>) => ({
  ozonList:(['watching','favorites','cart'].includes(String(search.ozonList)) ? search.ozonList : 'watching') as 'watching' | 'favorites' | 'cart',
  price:(search.price === 'regular' ? 'regular' : 'ozon_card') as 'regular' | 'ozon_card',
})});
export const router = createRouter({routeTree: root.addChildren([index, list, ozon])});
declare module '@tanstack/react-router' {interface Register {router: typeof router;}}
