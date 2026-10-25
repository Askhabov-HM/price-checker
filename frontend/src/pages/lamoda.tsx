import {useState} from 'react';
import {useCollectionData} from '@/hooks/use-collection-data';
import {Link,useNavigate,useSearch} from '@tanstack/react-router';
import {useMutation,useQuery} from '@tanstack/react-query';
import {RefreshCw,Settings} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {PriceChart} from '@/components/price-chart';
import {PriceChange,ProductFilters} from '@/components/product-table';
import {ScheduleFields} from '@/components/schedule-fields';
import {CollectionNotice} from '@/components/collection-notice';
import {date,rub} from '@/lib/format';
import {useNow} from '@/hooks/use-now';
import {invalidateLamoda,lamodaDashboardOptions,lamodaDetailOptions,lamodaMutate,lamodaStatusOptions,selectLamoda} from '@/lib/lamoda';
import type {LamodaStatus} from '@/lib/lamoda';
import type {ScheduleSettings} from '@/lib/types';

const stock:Record<string,string> = {available:'В наличии',unavailable:'Нет в наличии',unknown:'Наличие не подтверждено'};
function LamodaSettings({status,onClose}:{status:LamodaStatus;onClose:()=>void}) {
  const [value,setValue] = useState<ScheduleSettings>({schedule_enabled:status.schedule_enabled,schedule_mode:status.schedule_mode,schedule:status.schedule,interval_minutes:status.interval_minutes});
  const save = useMutation({mutationFn:() => lamodaMutate('settings',value),onSuccess:async () => {await invalidateLamoda();onClose();}});
  return <DialogContent><DialogHeader><DialogTitle>Расписание Lamoda</DialogTitle><DialogDescription>Проверки избранного по московскому времени.</DialogDescription></DialogHeader>
    <ScheduleFields value={value} onChange={setValue} prefix="lamoda" disabled={save.isPending}/>{save.error && <p role="alert">{save.error.message}</p>}
    <Button disabled={save.isPending} onClick={() => save.mutate()}>Сохранить</Button></DialogContent>;
}
export function LamodaDashboard() {
  const search = useSearch({from:'/lamoda'}),navigate = useNavigate({from:'/lamoda'}),now = useNow();
  const ready = useCollectionData('lamoda');
  const statusQuery = useQuery(lamodaStatusOptions),dashboard = useQuery({...lamodaDashboardOptions,enabled:ready}),status = statusQuery.data;
  const [selected,setSelected] = useState<string|null>(null),[days,setDays] = useState(30),[settings,setSettings] = useState(false);
  const detail = useQuery({...lamodaDetailOptions(selected,days),enabled:query => selected !== null && ready(query)});
  const refresh = useMutation({mutationFn:() => lamodaMutate('refresh'),onSuccess:invalidateLamoda});
  const waiting = !!status?.not_before && Date.parse(status.not_before)>now;
  const blocked = (!status?.configured || status.action_required) && !status?.mobile?.enabled || !status?.available || status.running || !!status?.desktop?.job || waiting || refresh.isPending;
  const error = statusQuery.error || dashboard.error || refresh.error;
  const items = dashboard.data?.items || [],visible = selectLamoda(items,search.q,search.filter,search.sort,search.changeDays,now);
  return <div><CollectionNotice status={status}/><section className="page-heading"><div><div className="eyebrow">LAMODA · ИЗБРАННОЕ</div><h1>Lamoda<span className="title-dot">.</span></h1><p>История цен ваших товаров</p></div>
    <div className="heading-actions"><div className="next-check"><span>Следующая проверка</span><strong>{status?.schedule_enabled ? date(status.next_check) : 'Не запланирована'}</strong></div>
      <Button disabled={blocked} onClick={() => refresh.mutate()}><RefreshCw size={15} className={status?.running && !status.queued ? 'rotating' : ''}/>{status?.queued ? 'В очереди…' : status?.running ? 'Проверяем…' : 'Обновить избранное и цены'}</Button></div></section>
    {error && <p role="alert" className="notice">{error.message}</p>}{status?.message && <p role="status" className="notice">{status.message}</p>}
    <p className="small-muted"><Link to="/lamoda/android" search={search}>{status?.mobile?.enabled ? '📱 Сбор через Android · управление телефоном' : 'Подключить Android для сбора избранного'}</Link></p>
    <p className="small-muted"><Link to="/lamoda/desktop" search={search}>💻 Пробный сбор с ПК · отдельная история</Link></p>
    {(!status?.configured || status.action_required) && !status?.mobile?.enabled && <p className="notice">Подключите нужный аккаунт для получения избранного. <Link to="/lamoda/login" search={search}>Войти в Lamoda</Link></p>}
    <section className="overview-card"><div className="card-heading"><div><h2>Ваше избранное</h2><p>Все категории · одна строка на товар и цвет</p></div><Button variant="outline" disabled={!status?.available} onClick={() => setSettings(true)}><Settings size={15}/>Расписание</Button></div>
      <p className="small-muted">{status?.schedule_enabled ? 'Расписание включено. ' : 'Автоматические проверки выключены. '}{status?.schedule_mode === 'hours' ? `Часы запуска: ${status.schedule.join(', ')}` : `Интервал: ${status?.interval_minutes || 30} минут`} · Москва</p>
      {waiting && <p className="small-muted">Lamoda разрешает следующую попытку после {date(status?.not_before)}.</p>}
      <div className="card-heading"><h2>Стоимость доступного избранного</h2></div><PriceChart.Root points={dashboard.data?.history || []} total><PriceChart.ScaleControls/><div className="overview-chart"><PriceChart.Plot id="lamoda-overview-chart"/></div></PriceChart.Root>
      <p className="chart-caption">Последние 30 дней. В сумму входят известные цены доступных товаров. При изменении состава линия прерывается.</p></section>
    <section className="products-card"><div className="products-title"><div><h2>Все товары <span>{visible.length}</span></h2><p>Нажмите на товар для просмотра истории</p></div></div>
      <p className="change-filter-hint">Синим отмечены недоступные товары. Сохранённая цена показана с исходной датой; ошибки проверок отмечены красным.</p>
      <ProductFilters idPrefix="lamoda-" searchLabel="Найти товар Lamoda" searchPlaceholder="Название, цвет или артикул" unavailableLabel="Нет в наличии" search={search.q} filter={search.filter} sort={search.sort} changeDays={search.changeDays}
        onChange={values => {void navigate({replace:true,search:previous => ({...previous,q:values.search ?? previous.q,filter:values.filter ?? previous.filter,sort:values.sort ?? previous.sort,changeDays:values.changeDays ?? previous.changeDays})});}}/>
      {dashboard.isPending ? <p role="status" className="notice">Загружаем товары Lamoda…</p> : <div className="ozon-table-wrap"><table className="history-table ozon-table"><thead><tr><th>Товар</th><th>Цена</th><th>Зачёркнутая цена</th><th>Последнее изменение</th><th>История</th><th>Проверка</th></tr></thead><tbody>
        {visible.map(item => {const unavailable = item.availability === 'unavailable',tone = item.status === 'error' ? 'ozon-error' : unavailable ? 'ozon-price-unavailable' : undefined;
          return <tr key={item.id}><td><button className="ozon-product" onClick={() => setSelected(item.id)}>{item.image_url && <img src={item.image_url} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>{item.sku} · {item.color} · <span className={unavailable ? 'availability-unavailable' : undefined}>{stock[item.availability]}</span></small></span></button></td>
            <td className={tone}><strong>{rub(item.price)}</strong>{unavailable && item.price!==null && <small>Последняя известная · {date(item.price_at)}</small>}</td><td className={tone}>{item.original_price===null ? '—' : <s>{rub(item.original_price)}</s>}</td>
            <td><PriceChange item={item} changeDays={search.changeDays} nowMs={now} unavailable={unavailable}/></td><td className="ozon-sparkline"><PriceChart.Root points={item.sparkline} total><PriceChart.Plot small/></PriceChart.Root></td>
            <td>{date(item.checked_at)}{item.status==='error' && <small className="ozon-error">{item.message} Цена от {date(item.price_at)}</small>}</td></tr>;})}
        {!visible.length && <tr><td colSpan={6} className="empty-state">{items.length ? 'Товары не найдены.' : 'Подключите аккаунт и обновите избранное.'}</td></tr>}</tbody></table></div>}
      <div className="table-footer"><span>Показано {visible.length} из {items.length}</span><span>Рубли · время по Москве</span></div></section>
    <section className="activity-card"><div className="card-heading"><h2>Проверки Lamoda</h2></div>{status?.checks?.map(check => <div className="activity-row" key={check.id}><span className={`activity-dot ${check.status}`}/><span className="activity-time">{date(check.finished_at || check.started_at)}</span><span className="activity-message">{check.message || 'Собираем избранное…'}</span><span>{check.completed}/{check.total}</span></div>)}</section>
    <Dialog open={settings} onOpenChange={setSettings}>{settings && status && <LamodaSettings status={status} onClose={() => setSettings(false)}/>}</Dialog>
    <Dialog open={selected!==null} onOpenChange={open => {if (!open) setSelected(null);}}><DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-[950px]"><DialogHeader className="dialog-top"><DialogTitle>{detail.data?.product.title || 'История цены'}</DialogTitle><DialogDescription>Текущая и зачёркнутая цены из избранного Lamoda.</DialogDescription></DialogHeader>
      <div className="detail-toolbar"><div className="period-tabs">{[7,30,90,0].map(period => <Button key={period} variant="ghost" aria-pressed={days===period} onClick={() => setDays(period)}>{period ? `${period} дней` : 'Всё время'}</Button>)}</div>{detail.data && <a href={detail.data.product.url} target="_blank" rel="noopener noreferrer">На Lamoda ↗</a>}</div>
      {detail.error ? <p role="alert" className="notice">{detail.error.message}</p> : <><PriceChart.Root points={detail.data?.points || []} total><PriceChart.ScaleControls detail/><div className="detail-chart-wrap"><PriceChart.Plot id="lamoda-detail-chart"/></div></PriceChart.Root>
        <div className="detail-table-wrap"><table className="history-table"><thead><tr><th>Проверено</th><th>Цена</th><th>Зачёркнутая цена</th><th>Цена получена</th><th>Результат</th></tr></thead><tbody>{detail.data?.points.toReversed().map(point => <tr key={point.checked_at} className={point.status==='error' ? 'ozon-error' : point.availability==='unavailable' ? 'ozon-price-unavailable' : undefined}>
          <td>{date(point.checked_at,{second:'2-digit'})}</td><td>{rub(point.price)}</td><td>{point.original_price===null ? '—' : <s>{rub(point.original_price)}</s>}</td><td>{date(point.price_at)}</td><td>{point.status==='error' ? point.message : stock[point.availability]}</td></tr>)}</tbody></table></div></>}
    </DialogContent></Dialog>
  </div>;
}
