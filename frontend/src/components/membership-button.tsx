import {useMutation, useQueryClient} from '@tanstack/react-query';
import {ShoppingBasket, Star} from 'lucide-react';
import {Button} from './ui/button';
import {dashboardOptions, mutate} from '@/lib/api';
import type {DashboardData, ListId, PriceContext} from '@/lib/types';

export function MembershipButton({id, active, list}: {id: number; active: boolean; list: 'watching' | 'my-cart'}) {
  const client = useQueryClient();
  const cart = list === 'my-cart', field = cart ? 'in_my_cart' : 'watching';
  const change = useMutation({
    mutationFn: () => mutate<{ok: boolean; count: number}>(cart ? '/api/my-cart' : '/api/watch', {id, active: !active}),
    onSuccess: async result => {
      // Only membership changes here: never turn an old price into a fresh one.
      await client.cancelQueries({queryKey: ['dashboard']});
      const cached = client.getQueriesData<DashboardData>({queryKey: ['dashboard']});
      for (const [key, data] of cached) {
        if (!data) continue;
        const source = cached.find(([, value]) => value?.context === data.context && value.items.some(item => item.id === id))?.[1]?.items.find(item => item.id === id);
        client.setQueryData<DashboardData>(key, previous => {
          if (!previous) return previous;
          let items = previous.items.map(item => item.id === id ? {...item, [field]: !active} : item);
          if (previous.list === list) {
            if (active) items = items.filter(item => item.id !== id);
            else if (source && !items.some(item => item.id === id)) items = [...items, {...source, [field]: true, quantity: 1}];
          }
          return {...previous, items, counts: {...previous.counts, [list]: result.count}};
        });
      }
      await client.invalidateQueries({queryKey: ['dashboard'], refetchType: 'none'});
      // The server also overlays local memberships on its frozen snapshot.
      // Explicit reads are safe during collection; ordinary price polling stays gated.
      await Promise.all(client.getQueryCache().findAll({queryKey: ['dashboard']})
        .filter(query => query.getObserversCount() > 0)
        .map(query => client.fetchQuery(dashboardOptions(query.queryKey[1] as ListId, query.queryKey[2] as PriceContext)).catch(() => {})));
    },
  });
  const label = cart ? active ? 'Убрать из моей корзины' : 'Добавить в мою корзину' : active ? 'Убрать из наблюдения' : 'Добавить в наблюдение';
  return <><Button variant="ghost" size="icon" className={`watch-button ${active ? 'selected' : ''}`} aria-label={label} aria-pressed={active}
    disabled={change.isPending} onClick={event => {event.stopPropagation(); change.mutate();}}>
    {cart ? <ShoppingBasket size={19}/> : <Star size={19} fill={active ? 'currentColor' : 'none'}/>}
  </Button>{change.error && <small role="alert" className="stale-label">{change.error.message}</small>}</>;
}
