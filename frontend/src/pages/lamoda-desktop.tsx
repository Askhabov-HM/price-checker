import {useState} from 'react';
import {Link,useNavigate,useSearch} from '@tanstack/react-router';
import {useQuery} from '@tanstack/react-query';
import {useCollectionData} from '@/hooks/use-collection-data';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {PriceChart} from '@/components/price-chart';
import {PriceChange,ProductFilters} from '@/components/product-table';
import {date,rub} from '@/lib/format';
import {useNow} from '@/hooks/use-now';
import {desktopDashboardOptions,desktopDetailOptions,lamodaStatusOptions,selectLamoda} from '@/lib/lamoda';

const stock:Record<string,string> = {available:'В наличии',unavailable:'Нет в наличии',unknown:'Наличие не подтверждено'};

export function LamodaDesktopPage() {
  const search = useSearch({from:'/lamoda/desktop'}),navigate = useNavigate({from:'/lamoda/desktop'}),now = useNow();
  const ready = useCollectionData('desktop');
  const statusQuery = useQuery(lamodaStatusOptions),dashboard = useQuery({...desktopDashboardOptions,enabled:ready}),desktop = statusQuery.data?.desktop;
  const [selected,setSelected] = useState<string|null>(null),[days,setDays] = useState(30);
  const detail = useQuery({...desktopDetailOptions(selected,days),enabled:query => selected !== null && ready(query)});
  const error = statusQuery.error || dashboard.error;
  const items = dashboard.data?.items || [];
  const visible = selectLamoda(items,search.q,search.filter,search.sort,search.changeDays,now);
  return <div><section className="page-heading"><div><div className="eyebrow">LAMODA · АРХИВ ПК</div><h1>Lamoda<span className="title-dot">.</span> ПК</h1><p>Ранее сохранённые снимки ноутбука · отдельная история</p></div></section>
    {error && <p role="alert" className="notice">{error.message}</p>}
    <p className="small-muted"><Link to="/lamoda" search={search}>← Основной сбор Lamoda</Link></p>
    <section className="overview-card"><div className="card-heading"><div><h2>История ПК</h2><p>Windows-программа теперь только открывает избранное Lamoda в Chrome и не создаёт новых снимков.</p></div></div>
      {desktop?.latest && <p>Последний снимок: {date(desktop.latest.received_at)} · {desktop.latest.item_count} товаров.</p>}
    </section>
    <section className="overview-card"><div className="card-heading"><div><h2>Стоимость доступного избранного · ПК</h2><p>Ранее сохранённые снимки.</p></div></div>
      <PriceChart.Root points={dashboard.data?.history || []} total><PriceChart.ScaleControls/><div className="overview-chart"><PriceChart.Plot id="lamoda-desktop-overview-chart"/></div></PriceChart.Root>
      <p className="chart-caption">До 1000 последних снимков за 30 дней. В сумму входят известные цены доступных товаров; при изменении состава линия прерывается.</p></section>
    <section className="products-card"><div className="products-title"><div><h2>Все товары <span>{visible.length}</span></h2><p>Нажмите на товар для просмотра истории снимков ПК</p></div></div>
      <p className="change-filter-hint">Синим отмечены недоступные товары. Сохранённая цена показана с исходной датой; ошибки сборов отмечены красным.</p>
      <ProductFilters idPrefix="lamoda-desktop-" searchLabel="Найти товар в снимках ПК" searchPlaceholder="Название, цвет или артикул" unavailableLabel="Нет в наличии" search={search.q} filter={search.filter} sort={search.sort} changeDays={search.changeDays}
        onChange={values => {void navigate({replace:true,search:previous => ({...previous,q:values.search ?? previous.q,filter:values.filter ?? previous.filter,sort:values.sort ?? previous.sort,changeDays:values.changeDays ?? previous.changeDays})});}}/>
      {dashboard.isPending ? <p role="status" className="notice">Загружаем снимки ПК…</p> : <div className="ozon-table-wrap"><table className="history-table ozon-table"><thead><tr><th>Товар</th><th>Цена</th><th>Зачёркнутая цена</th><th>Последнее изменение</th><th>История</th><th>Проверка ПК</th></tr></thead><tbody>
        {visible.map(item => {const unavailable = item.availability === 'unavailable',tone = item.status === 'error' ? 'ozon-error' : unavailable ? 'ozon-price-unavailable' : undefined;
          return <tr key={item.id}><td><button className="ozon-product" onClick={() => setSelected(item.id)}>{item.image_url && <img src={item.image_url} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>{item.sku} · {item.color} · <span className={unavailable ? 'availability-unavailable' : undefined}>{stock[item.availability]}</span></small></span></button></td>
            <td className={tone}><strong>{rub(item.price)}</strong>{unavailable && item.price!==null && <small>Последняя известная · {date(item.price_at)}</small>}</td><td className={tone}>{item.original_price===null ? '—' : <s>{rub(item.original_price)}</s>}</td>
            <td><PriceChange item={item} changeDays={search.changeDays} nowMs={now} unavailable={unavailable}/></td><td className="ozon-sparkline"><PriceChart.Root points={item.sparkline} total><PriceChart.Plot small/></PriceChart.Root></td>
            <td>{date(item.checked_at)}{item.status==='error' && <small className="ozon-error">Ошибка сбора: {item.message}. Цена от {date(item.price_at)}</small>}</td></tr>;})}
        {!visible.length && <tr><td colSpan={6} className="empty-state">{items.length ? 'Товары не найдены.' : 'Пока нет снимков ПК.'}</td></tr>}</tbody></table></div>}
      <div className="table-footer"><span>Показано {visible.length} из {items.length}</span><span>Рубли · время по Москве</span></div></section>
    <section className="activity-card"><div className="card-heading"><h2>Ранее выполненные проверки ПК</h2></div>{dashboard.data?.activity.map((entry,index) => <div className="activity-row" key={entry.run_id || `${entry.at}:${index}`}>
      <span className={`activity-dot ${entry.status}`}/><span className="activity-time">{date(entry.at,{second:'2-digit'})}</span>
      <span className="activity-message">{entry.status === 'success' ? `Снимок сохранён · ${entry.count} товаров` : `Ошибка сбора: ${entry.message}`}</span></div>)}</section>
    <Dialog open={selected!==null} onOpenChange={open => {if (!open) setSelected(null);}}><DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-[950px]"><DialogHeader className="dialog-top"><DialogTitle>{detail.data?.product.title || 'История цены · ПК'}</DialogTitle><DialogDescription>Только цены из пробных снимков ноутбука.</DialogDescription></DialogHeader>
      <div className="detail-toolbar"><div className="period-tabs">{[7,30,90,0].map(period => <Button key={period} variant="ghost" aria-pressed={days===period} onClick={() => setDays(period)}>{period ? `${period} дней` : 'Всё время'}</Button>)}</div>{detail.data && <a href={detail.data.product.url} target="_blank" rel="noopener noreferrer">На Lamoda ↗</a>}</div>
      {detail.error ? <p role="alert" className="notice">{detail.error.message}</p> : <><PriceChart.Root points={detail.data?.points || []} total><PriceChart.ScaleControls detail/><div className="detail-chart-wrap"><PriceChart.Plot id="lamoda-desktop-detail-chart"/></div></PriceChart.Root>
        <div className="detail-table-wrap"><table className="history-table"><thead><tr><th>Проверено ПК</th><th>Цена</th><th>Зачёркнутая цена</th><th>Цена получена</th><th>Результат</th></tr></thead><tbody>{detail.data?.points.toReversed().map(point => <tr key={point.checked_at} className={point.status==='error' ? 'ozon-error' : point.availability==='unavailable' ? 'ozon-price-unavailable' : undefined}>
          <td>{date(point.checked_at,{second:'2-digit'})}</td><td>{rub(point.price)}</td><td>{point.original_price===null ? '—' : <s>{rub(point.original_price)}</s>}</td><td>{date(point.price_at)}</td><td>{point.status==='error' ? point.message : stock[point.availability]}</td></tr>)}</tbody></table></div></>}
    </DialogContent></Dialog>
  </div>;
}
