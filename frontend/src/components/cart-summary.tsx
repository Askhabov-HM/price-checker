import {rub} from '@/lib/format';
import type {CartListId, ProductRow} from '@/lib/types';

export function cartTotals(items: ProductRow[], discountEnabled: boolean) {
  const available = items.filter(item => item.status === 'ok' && item.in_stock && item.price != null);
  const subtotal = available.reduce((sum, item) => sum + item.price!, 0);
  const total = discountEnabled ? Math.round(subtotal * 90 / 100) : subtotal;
  return {count: available.length, subtotal, total, savings: subtotal - total};
}

export function CartSummary({list, items, discountEnabled, onDiscountChange, loading = false}: {
  list: CartListId; items: ProductRow[]; discountEnabled: boolean; onDiscountChange: (enabled: boolean) => void; loading?: boolean;
}) {
  const {count, subtotal, total, savings} = cartTotals(items, discountEnabled);
  return <section className="overview-card mb-6" aria-label={list === 'my-cart' ? 'Расчёт моей корзины' : 'Расчёт корзины Randewoo'}>
    <div className="card-heading flex-wrap"><div><h2>Расчёт корзины</h2><p>{count} доступных из {items.length} · по одному пробнику · без доставки</p></div>
      <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs" htmlFor={`${list}-discount`}>
        <input id={`${list}-discount`} type="checkbox" className="size-4 accent-primary" checked={discountEnabled} disabled={loading} onChange={event => onDiscountChange(event.target.checked)} />
        Скидка 10%
      </label>
    </div>
    <dl className="grid grid-cols-1 gap-4 px-6 pb-5 min-[700px]:grid-cols-3">
      <div><dt className="text-xs text-muted-foreground">До скидки</dt><dd id={`${list}-subtotal`} className="mt-2 text-2xl font-semibold">{rub(loading ? null : subtotal)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Экономия</dt><dd id={`${list}-savings`} className="mt-2 text-2xl font-semibold">{rub(loading ? null : savings)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{discountEnabled ? 'Итого со скидкой 10%' : 'Итого без скидки'}</dt><dd id={`${list}-total`} className="mt-2 text-2xl font-semibold text-primary">{rub(loading ? null : total)}</dd></div>
    </dl>
  </section>;
}
