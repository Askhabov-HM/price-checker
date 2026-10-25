import {useEffect, useState} from 'react';
import {useNavigate, useParams, useSearch} from '@tanstack/react-router';
import {useMutation, useQuery} from '@tanstack/react-query';
import {RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {PriceChart} from '@/components/price-chart';
import {ProductTable} from '@/components/product-table';
import {CartSummary, cartTotals} from '@/components/cart-summary';
import {DetailDialog} from '@/components/detail-dialog';
import {dashboardOptions, invalidatePrices, mutate, statusOptions} from '@/lib/api';
import {date, labels, rub} from '@/lib/format';
import {recentChangeCounts} from '@/lib/price-changes';
import {usePreferences} from '@/lib/store';
import {useNow} from '@/hooks/use-now';
import {CollectionNotice} from '@/components/collection-notice';
import {useCollectionData} from '@/hooks/use-collection-data';
import type {ListId, PriceContext} from '@/lib/types';

export function Dashboard() {
  const {listId} = useParams({from: '/$listId'}), list = listId as ListId;
  const search = useSearch({from: '__root__'}), navigate = useNavigate({from: '/$listId'});
  const context = list === 'my-cart' ? 'public' : search.context;
  const ready = useCollectionData('randewoo');
  const dashboard = useQuery({...dashboardOptions(list, context),enabled:ready}), statusQuery = useQuery(statusOptions);
  const data = dashboard.data, status = statusQuery.data || data?.status;
  const nowMs = useNow(), changes = recentChangeCounts(data?.items || [], search.changeDays, nowMs);
  const [detailId, setDetailId] = useState<number | null>(null);
  useEffect(() => {setDetailId(null);}, [list]);
  const refresh = useMutation({mutationFn: () => mutate('/api/refresh', {}), onSuccess: invalidatePrices});
  const cartList = list === 'cart' || list === 'my-cart' ? list : null;
  const cartDiscounts = usePreferences(state => state.cartDiscounts), setCartDiscount = usePreferences(state => state.setCartDiscount);
  const discountEnabled = cartList ? cartDiscounts[cartList] : false;
  const totals = cartTotals(data?.items || [], discountEnabled);
  const latest = data?.items.map(item => item.checked_at).filter((value): value is string => !!value).sort().pop();
  const check = status?.checks[0], latestFinished = status?.checks.find(item => item.trigger !== 'import' && item.finished_at);
  const notice = ['expired', 'error'].includes(status?.auth_status || '') ? `${status?.auth_message}. Список товаров сохранён; публичные цены продолжают проверяться.` : latestFinished && ['error', 'partial', 'interrupted'].includes(latestFinished.status) ? latestFinished.message : null;
  const overview = data?.history.map(point => ({...point, price: point.priced_count ? point.known_total : null})) || [];
  const measured = overview.filter(point => point.price != null), lastPoint = measured.at(-1);
  const statusLabels: Record<string, string> = {success: 'Готово', partial: 'Частично', error: 'Ошибка', running: 'Проверка', imported: 'Импорт истории', interrupted: 'Прервана'};
  const triggerLabels: Record<string, string> = {manual: 'Вручную', schedule: 'По расписанию', initial: 'Первая проверка', cli: 'Из командной строки', import: 'Реальный снимок'};
  return <div data-dashboard data-check-id={data?.status.checks[0]?.id ?? 0} data-running={data?.status.running ?? false}>
    <CollectionNotice status={status}/>
    <section className="page-heading"><div><div className="eyebrow">{list === 'my-cart' ? 'МОЯ ПОДБОРКА' : 'RANDEWOO'} · ВАРИАНТЫ 1,5 МЛ</div><h1 id="page-title">{labels[list]}<span className="title-dot">.</span></h1><p>{list === 'my-cart' ? 'Ароматы для следующего заказа. По одному пробнику каждого.' : 'Любимые ароматы. Полная история каждой цены.'}</p></div><div className="heading-actions"><div className="next-check"><span>Следующая проверка</span><strong id="next-check">{status?.schedule_enabled ? date(status.next_check) : 'На паузе'}</strong></div><Button id="refresh-button" disabled={!status || status.running || refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw id="refresh-icon" size={15} className={status?.running && !status.queued ? 'rotating' : ''} /><span id="refresh-label">{status?.queued ? 'В очереди…' : status?.running || refresh.isPending ? 'Проверяем…' : 'Проверить цены'}</span></Button></div></section>
    {(notice || dashboard.error || refresh.error) && <div id="notice" className="notice" role="alert">{refresh.error?.message || dashboard.error?.message || notice}</div>}
    {status?.running && !status.queued && <div id="progress" className="progress-panel" role="status"><span className="spinner" /><div><strong id="progress-title">{check?.total ? `Проверяем цены: ${check.completed} из ${check.total}` : 'Обновляем корзину и избранное'}</strong><p>Получаем данные сайта. Предыдущая история остаётся доступной.</p></div><progress id="progress-bar" max={check?.total || 100} value={check?.completed || 0} /></div>}
    <section className="metrics price-metrics" aria-label="Обзор списка">
      <article className="metric"><div className="metric-label">Товаров в списке<span>▦</span></div><div className="metric-value" id="metric-count">{data?.items.length ?? '—'}</div><div className="metric-foot">Каждый вариант — 1,5 мл</div></article>
      <article className="metric"><div className="metric-label">{discountEnabled ? 'Стоимость со скидкой 10%' : 'Стоимость набора'}<span>₽</span></div><div className="metric-value" id="metric-total">{totals.count ? rub(totals.total) : '—'}</div><div className="metric-foot">{totals.count} доступных из {data?.items.length ?? 0} · по одному пробнику</div></article>
      <Button variant="ghost" className="metric accent metric-action h-auto min-w-0 flex-col items-stretch gap-0 whitespace-normal p-5 text-left" aria-label={`Показать подешевевшие за ${search.changeDays} дней`} aria-pressed={search.filter === 'drops'} onClick={() => {void navigate({search: previous => ({...previous, filter: previous.filter === 'drops' ? 'all' : 'drops'})});}}><span className="metric-label">Подешевели<span>↘</span></span><span className="metric-value" id="metric-drops">{data ? changes.drops : '—'}</span><span className="metric-foot">Последнее изменение за {search.changeDays} дней</span></Button>
      <Button variant="ghost" className="metric metric-action h-auto min-w-0 flex-col items-stretch gap-0 whitespace-normal p-5 text-left" aria-label={`Показать подорожавшие за ${search.changeDays} дней`} aria-pressed={search.filter === 'rises'} onClick={() => {void navigate({search: previous => ({...previous, filter: previous.filter === 'rises' ? 'all' : 'rises'})});}}><span className="metric-label">Подорожали<span>↗</span></span><span className="metric-value" id="metric-rises">{data ? changes.rises : '—'}</span><span className="metric-foot">Последнее изменение за {search.changeDays} дней</span></Button>
      <article className="metric"><div className="metric-label">Последняя проверка<span>◷</span></div><div className="metric-value time-value" id="metric-time">{date(latest, {day: undefined, month: undefined})}</div><div className="metric-foot">{latest ? date(latest, {hour: undefined, minute: undefined, year: 'numeric'}) : 'Данные ещё не получены'}</div></article>
    </section>
    {cartList && <CartSummary list={cartList} items={data?.items || []} discountEnabled={discountEnabled} onDiscountChange={enabled => setCartDiscount(cartList, enabled)} loading={dashboard.isPending || !!dashboard.error} />}
    <section className="overview-card"><div className="card-heading"><div><h2>Как меняется стоимость набора</h2><p>{cartList ? 'Без скидки по промокоду · ' : ''}По одному доступному варианту каждого товара · последние 30 дней</p></div>{list !== 'my-cart' && <label className="context-label"><span>Тип цены</span><select id="price-context" aria-label="Тип цены" value={context} onChange={event => {void navigate({search: previous => ({...previous, context: event.target.value as PriceContext})});}}><option value="public">На сайте</option><option value="cart">В корзине</option></select></label>}</div>
      <PriceChart.Root points={overview} total><PriceChart.ScaleControls /><div className="overview-chart"><PriceChart.Plot id="overview-chart" /><p id="overview-caption" className="chart-caption">{!lastPoint ? 'Пока нет цен доступных вариантов.' : !lastPoint.complete ? `Сумма доступных вариантов: ${lastPoint.priced_count} из ${lastPoint.count}. Остальные позиции в сумму не включены.` : measured.length === 1 ? 'Первая точка сохранена. Линия появится после следующей проверки.' : 'Каждая точка — выполненная проверка'}</p></div></PriceChart.Root><div className="chart-footer"><span><i className="legend-dot" /> Только реальные проверки</span><span>При изменении состава набора линия прерывается.</span></div>
    </section>
    {dashboard.isPending ? <p role="status" className="notice">Загружаем товары…</p> : <ProductTable.Root list={list} items={data?.items || []} search={search.q} filter={search.filter} sort={search.sort} changeDays={search.changeDays} nowMs={nowMs} onChange={values => {void navigate({replace: true, search: previous => ({...previous, filter: values.filter ?? previous.filter, sort: values.sort ?? previous.sort, q: values.search ?? previous.q, changeDays: values.changeDays ?? previous.changeDays})});}} onSelect={setDetailId}>
      <div className="products-title"><div><h2>Все товары <ProductTable.Count /></h2><p>Нажмите на товар, чтобы открыть историю цены</p></div><Button variant="outline" className="text-button" id="export-button" asChild><a href={`/api/export?list=${list}&context=${context}`}>↓ Экспорт CSV</a></Button></div><p className="change-filter-hint">Учитываем последнее изменение цены. Повторные проверки с той же ценой не сбрасывают отметку.</p><ProductTable.Toolbar /><ProductTable.Rows /><ProductTable.Summary />
    </ProductTable.Root>}
    <section className="activity-card"><div className="card-heading"><h2>Последние проверки</h2><span className="small-muted">История обновлений</span></div><div id="activity-list">{status?.checks.slice(0, 8).map(item => <div className="activity-row" key={item.id}><span className={`activity-dot ${item.status}`} /><span className="activity-time">{date(item.finished_at || item.started_at)}</span><span className="activity-trigger">{triggerLabels[item.trigger] || item.trigger}</span><span className="activity-message">{item.message || 'Получаем список товаров…'}</span><span className={`activity-badge ${item.status}`}>{statusLabels[item.status] || item.status}</span></div>)}{!status?.checks.length && <div className="activity-empty">Здесь появятся результаты первой проверки.</div>}</div></section>
    <DetailDialog.Root id={detailId} context={context} days={search.days} onClose={() => setDetailId(null)} onPeriod={days => {void navigate({search: previous => ({...previous, days})});}}><DetailDialog.Content><DetailDialog.Toolbar /><DetailDialog.Chart /><DetailDialog.History /></DetailDialog.Content></DetailDialog.Root>
  </div>;
}
