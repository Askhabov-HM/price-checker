import {useEffect, useState} from 'react';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {useMutation, useQuery} from '@tanstack/react-query';
import {RefreshCw, Plus, Pause, Play, Settings} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {PriceChart} from '@/components/price-chart';
import {PriceChange, ProductFilters} from '@/components/product-table';
import {OzonSettingsDialog} from '@/components/forms';
import {date, rub} from '@/lib/format';
import {useNow} from '@/hooks/use-now';
import {invalidateOzon, ozonDashboardOptions, ozonDetailOptions, ozonMutate, ozonStatusOptions, ozonPrice, ozonProductPoints, ozonOverviewPoints, ozonUnavailable, selectOzonProducts} from '@/lib/ozon';
import type {OzonList, OzonPrice} from '@/lib/ozon';

const labels: Record<OzonList,string> = {favorites:'Избранное',watching:'Наблюдение',cart:'Корзина Ozon'};
const stock: Record<string,string> = {available:'В наличии',out_of_stock:'Нет в наличии',unavailable:'Недоступен',unknown:'Наличие не подтверждено'};
export function OzonDashboard() {
  const search = useSearch({from:'/ozon'}), navigate = useNavigate({from:'/ozon'});
  const statusQuery = useQuery(ozonStatusOptions), dashboard = useQuery(ozonDashboardOptions(search.ozonList));
  const status = statusQuery.data, now = useNow();
  const [url,setUrl] = useState(''), [selected,setSelected] = useState<string | null>(null), [days,setDays] = useState(30);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const detail = useQuery(ozonDetailOptions(selected,days));
  const refresh = useMutation({mutationFn:(id: string | null) => ozonMutate('refresh',id ? {id} : {}),onSuccess:invalidateOzon});
  const schedule = useMutation({mutationFn:(enabled: boolean) => ozonMutate('settings',{schedule_enabled:enabled}),onSuccess:invalidateOzon});
  const add = useMutation({mutationFn:() => ozonMutate<{id:string}>('watch/add',{url}),onSuccess:() => {setUrl(''); void navigate({search:previous => ({...previous,ozonList:'watching'})}); return invalidateOzon();}});
  const remove = useMutation({mutationFn:(id: string) => ozonMutate('watch/remove',{id}),onSuccess:invalidateOzon});
  const latestCheck = status?.checks?.[0], version = latestCheck ? `${latestCheck.id}:${latestCheck.status}:${latestCheck.completed}` : '';
  useEffect(() => {void invalidateOzon();},[version]);
  const waiting = !!status?.not_before && Date.parse(status.not_before) > now;
  const blocked = !status?.configured || !status.available || status.running || status.action_required || waiting || refresh.isPending;
  const error = refresh.error || add.error || remove.error || schedule.error || dashboard.error || statusQuery.error;
  const items = dashboard.data?.items || [], displayed = selectOzonProducts(items,search.q,search.filter,search.sort,search.price,search.changeDays,now);
  const priced = items.filter(item => ozonPrice(item,search.price) !== null).length;
  const priceLabel = search.price === 'listed' ? 'Цена Ozon' : search.price === 'regular' ? 'Обычная цена' : 'Ozon Карта';
  const points = ozonProductPoints(detail.data?.points || [],search.price);
  const overview = ozonOverviewPoints(dashboard.data?.history || [],search.price);
  const lastPoint = overview.at(-1), measured = overview.filter(point => point.price != null && point.status !== 'error');
  const selectPrice = <label className="context-label"><span>Тип цены</span><select aria-label="Тип цены Ozon" value={search.price} onChange={event => {void navigate({search:previous => ({...previous,price:event.target.value as OzonPrice})});}}><option value="listed">Цена Ozon</option><option value="ozon_card">По Ozon Карте</option><option value="regular">Обычная цена</option></select></label>;
  return <div data-ozon-dashboard><section className="page-heading"><div><div className="eyebrow">OZON · ЛЮБЫЕ КАТЕГОРИИ</div><h1>Ozon<span className="title-dot">.</span></h1><p>История цен избранных товаров</p></div><div className="heading-actions"><div className="next-check"><span>Следующая проверка</span><strong>{status?.schedule_enabled ? date(status.next_check) : 'На паузе'}</strong></div><Button disabled={blocked} onClick={() => refresh.mutate(null)}><RefreshCw size={15} className={status?.running ? 'rotating' : ''}/>{status?.running ? 'Проверяем…' : 'Обновить избранное и цены'}</Button></div></section>
    {error && <p role="alert" className="notice">{error.message}</p>}
    {!status?.configured && statusQuery.isSuccess && <p className="notice">Подключение Ozon ещё не настроено. Добавленные товары и история сохраняются.</p>}
    {status?.message && <p role="status" className="notice">{status.message}</p>}
    {status?.login?.available && <p className="notice">{status.login.required ? 'Нужно восстановить вход в Ozon. ' : ''}<a href="/ozon/login">{status.login.active ? 'Продолжить вход в Ozon' : 'Открыть окно входа Ozon'}</a></p>}
    {status?.running && <div className="progress-panel" role="status"><span className="spinner"/><div><strong>Проверяем Ozon: {latestCheck?.completed || 0} из {latestCheck?.total || '…'}</strong><p>Предыдущие цены остаются доступны.</p></div></div>}
    <section className="overview-card ozon-controls"><div className="card-heading"><div><h2>Ваши товары</h2><p>Обновляем всё избранное и цены из списка</p></div><div className="ozon-schedule-actions"><Button variant="outline" disabled={!status} onClick={() => setSettingsOpen(true)}><Settings size={15}/>Настроить расписание</Button><Button variant="outline" disabled={!status?.available || schedule.isPending || (!status.schedule_enabled && (!status.configured || status.action_required))} onClick={() => schedule.mutate(!status?.schedule_enabled)}>{status?.schedule_enabled ? <Pause size={15}/> : <Play size={15}/>} {status?.schedule_enabled ? 'Приостановить расписание' : 'Возобновить расписание'}</Button></div></div>
      <form className="ozon-add" onSubmit={event => {event.preventDefault(); add.mutate();}}><Input type="url" required aria-label="Ссылка на товар Ozon" placeholder="https://www.ozon.ru/product/…" value={url} onChange={event => setUrl(event.target.value)}/><Button disabled={add.isPending || !url.trim()}><Plus size={15}/>Добавить товар</Button></form>
      <p className="small-muted">{status?.schedule_enabled ? 'Расписание включено. ' : 'Автоматические проверки выключены. '}{waiting ? `Следующая проверка доступна после ${date(status?.not_before)}.` : 'Можно проверить выбранный товар вручную.'}</p>
      {status && <p className="small-muted">{status.schedule_mode === 'hours' ? `Часы запуска: ${status.schedule?.join(', ') || 'не выбраны'} · Москва` : `Интервал: ${status.interval_minutes} минут`}</p>}
      {search.ozonList !== 'favorites' && <p className="small-muted">Общее обновление собирает только избранное. Товары этого списка можно проверить по одному; состав корзины больше не обновляется.</p>}
    </section>
    <section className="overview-card"><div className="ozon-toolbar"><div className="period-tabs" role="group" aria-label="Списки Ozon">{(Object.keys(labels) as OzonList[]).map(list => <Button variant="ghost" key={list} aria-pressed={search.ozonList === list} className={search.ozonList === list ? 'active' : ''} onClick={() => {setSelected(null); void navigate({search:previous => ({...previous,ozonList:list})});}}>{labels[list]} · {dashboard.data?.counts[list] || 0}</Button>)}</div>{selectPrice}</div>
      <div className="card-heading"><div><h2>Как меняется стоимость списка</h2><p>{labels[search.ozonList]} · {search.ozonList === 'cart' ? 'с учётом количества в корзине' : 'по одной единице каждого товара'} · последние 30 дней</p></div></div>
      <PriceChart.Root points={overview} total><PriceChart.ScaleControls/><div className="overview-chart"><PriceChart.Plot id="ozon-overview-chart"/><p className="chart-caption">{!lastPoint ? 'Пока нет проверок этого списка с сохранённым составом.' : lastPoint.status === 'error' ? `Ошибка проверки. Свежие цены получены: ${lastPoint.priced_count} из ${lastPoint.count}. Прежние цены не добавляются в сумму.` : !lastPoint.complete ? `Сумма доступных товаров: ${lastPoint.priced_count} из ${lastPoint.count}. Остальные позиции в сумму не включены.` : measured.length === 1 ? 'Первая точка сохранена. Линия появится после следующей проверки.' : 'Каждая точка — выполненная проверка.'}</p></div></PriceChart.Root>
      <div className="chart-footer"><span><i className="legend-dot"/> Только реальные проверки</span><span>При изменении состава, количества или продавца линия прерывается.</span></div>
    </section>
    <section className="products-card"><div className="products-title"><div><h2>Все товары <span>{displayed.length}</span></h2><p>Нажмите на товар, чтобы открыть историю цены</p></div><span className="small-muted">Цены известны: {priced} из {items.length}</span></div>
      <p className="change-filter-hint">Учитываем последнее изменение цены за выбранный период. Синим отмечены товары не в наличии. Отслеживаем их возвращение; новая цена сравнивается с последней известной.</p>
      <ProductFilters idPrefix="ozon-" searchLabel="Найти товар Ozon" searchPlaceholder="Название или артикул" unavailableLabel="Нет в наличии / недоступны" search={search.q} filter={search.filter} sort={search.sort} changeDays={search.changeDays} onChange={values => {void navigate({replace:true,search:previous => ({...previous,q:values.search ?? previous.q,filter:values.filter ?? previous.filter,sort:values.sort ?? previous.sort,changeDays:values.changeDays ?? previous.changeDays})});}}/>
      {dashboard.isPending ? <p role="status" className="notice">Загружаем товары Ozon…</p> : <div className="ozon-table-wrap"><table className="history-table ozon-table">
        <thead><tr><th>Товар</th><th>{priceLabel}</th>{search.price === 'listed' && <th>Зачёркнутая цена</th>}<th>Последнее изменение</th><th>История</th><th>Проверка</th><th>Действия</th></tr></thead>
        <tbody>{displayed.map(item => <tr key={item.id}>
          <td><button type="button" className="ozon-product" onClick={() => setSelected(item.id)}>{item.image_url && <img src={item.image_url} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>Арт. {item.sku} · <span className={ozonUnavailable(item) ? 'availability-unavailable' : undefined}>{stock[item.availability] || stock.unknown}</span></small></span></button></td>
          <td className={ozonUnavailable(item) ? 'ozon-price-unavailable' : undefined}><strong>{rub(ozonPrice(item,search.price))}</strong>{ozonUnavailable(item) && ozonPrice(item,search.price) !== null && <small>Последняя известная · {date(item.price_at)}</small>}</td>
          {search.price === 'listed' && <td className={ozonUnavailable(item) ? 'ozon-price-unavailable' : undefined}>{item.original_price_kopecks === null ? '—' : <s>{rub(item.original_price_kopecks)}</s>}</td>}
          <td className="ozon-price-change"><PriceChange item={{status:item.status,last_change:item.price_summary?.[search.price].last_change ?? null,observations:item.price_summary?.[search.price].observations ?? 0}} changeDays={search.changeDays} nowMs={now} unavailable={ozonUnavailable(item)}/></td>
          <td className="ozon-sparkline"><PriceChart.Root points={ozonProductPoints(item.sparkline,search.price)} total><PriceChart.Plot small/></PriceChart.Root><small className="sparkline-label">{item.sparkline.length ? `${item.sparkline.length} проверок` : 'Проверок ещё нет'}</small></td>
          <td>{date(item.checked_at)}{item.status === 'error' && <small className="ozon-error">{item.message} Цена от {date(item.price_at)}</small>}{item.status === 'pending' && <small>Ожидает проверки</small>}</td>
          <td><div className="ozon-row-actions"><Button variant="outline" size="sm" onClick={() => setSelected(item.id)}>История</Button>{search.ozonList !== 'favorites' && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => refresh.mutate(item.id)}>Проверить карточку</Button>}{search.ozonList === 'watching' && <Button variant="ghost" size="sm" disabled={remove.isPending || status?.running} aria-label={`Убрать из наблюдения: ${item.title}`} onClick={() => remove.mutate(item.id)}>Убрать</Button>}</div></td>
        </tr>)}{!displayed.length && <tr><td colSpan={search.price === 'listed' ? 7 : 6} className="empty-state">{items.length ? 'Товары не найдены.' : 'Обновите избранное аккаунта. Здесь появятся товары и их цены.'}</td></tr>}</tbody>
      </table></div>}
      <div className="table-footer"><span>Показано {displayed.length} из {items.length} товаров</span><span>Цены в рублях · время по Москве</span></div>
    </section>
    <section className="activity-card"><div className="card-heading"><h2>Проверки Ozon</h2></div>{status?.checks?.map(check => <div className="activity-row" key={check.id}><span className={`activity-dot ${check.status}`}/><span className="activity-time">{date(check.finished_at || check.started_at)}</span><span className="activity-message">{check.message || 'Проверка выполняется…'}</span><span>{check.completed}/{check.total}</span></div>)}{!status?.checks?.length && <p className="activity-empty">Проверок ещё нет.</p>}</section>
    <OzonSettingsDialog status={status} open={settingsOpen} onClose={() => setSettingsOpen(false)}/>
    <Dialog open={selected !== null} onOpenChange={open => {if (!open) setSelected(null);}}><DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-[950px]"><DialogHeader className="dialog-top"><div className="eyebrow">OZON · ИСТОРИЯ ЦЕНЫ</div><DialogTitle>{detail.data?.product.title || 'История товара'}</DialogTitle><DialogDescription>Цена сохраняется при обновлении избранного. Прежние цены из карточек доступны через выбор типа цены.</DialogDescription></DialogHeader>
      {detail.error ? <p role="alert" className="notice">{detail.error.message}</p> : detail.isPending ? <p role="status" className="notice">Загружаем историю…</p> : <><div className="detail-toolbar"><div className="period-tabs">{[7,30,90,0].map((period,index) => <Button variant="ghost" key={period} className={days === period ? 'active' : ''} aria-pressed={days === period} onClick={() => setDays(period)}>{['Неделя','Месяц','3 месяца','Всё время'][index]}</Button>)}</div>{selectPrice}<a href={detail.data?.product.url} target="_blank" rel="noopener noreferrer">На Ozon ↗</a></div>
        <PriceChart.Root points={points} total><PriceChart.ScaleControls detail/><div className="detail-chart-wrap"><PriceChart.Plot id="ozon-detail-chart"/></div></PriceChart.Root><p className="detail-note">{points.filter(point => point.status === 'ok').length === 1 ? 'Первая реальная проверка сохранена. Линия появится после следующей.' : 'График разделяется при смене продавца. Ошибки не заменяют последнюю известную цену.'}</p>
        {!!detail.data?.seller_events.length && <div className="notice">{detail.data.seller_events.map((event,index) => <p key={index}>{date(event.checked_at)} · Продавец изменился: {event.old_name || 'Прежний'} → {event.new_name || 'Новый'}</p>)}</div>}
        <div className="detail-table-wrap"><table className="history-table"><thead><tr><th>Дата</th><th>{priceLabel}</th>{search.price === 'listed' && <th>Зачёркнутая цена</th>}<th>Результат</th></tr></thead><tbody>{detail.data?.points.toReversed().map((point,index) => <tr key={index}><td>{date(point.checked_at,{second:'2-digit'})}</td><td className={ozonUnavailable(point) ? 'ozon-price-unavailable' : undefined}>{rub(ozonPrice(point,search.price))}</td>{search.price === 'listed' && <td className={ozonUnavailable(point) ? 'ozon-price-unavailable' : undefined}>{point.original_price_kopecks === null ? '—' : <s>{rub(point.original_price_kopecks)}</s>}</td>}<td className={ozonUnavailable(point) ? 'availability-unavailable' : undefined}>{point.status === 'error' ? point.message : stock[point.availability] || stock.unknown}</td></tr>)}{!points.length && <tr><td colSpan={search.price === 'listed' ? 4 : 3} className="empty-state">В выбранном периоде проверок нет.</td></tr>}</tbody></table></div></>}
    </DialogContent></Dialog>
  </div>;
}
