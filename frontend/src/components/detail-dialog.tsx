import {createContext, useContext, useMemo, type ReactNode} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {PriceChart} from './price-chart';
import {detailOptions} from '@/lib/api';
import {date, rub} from '@/lib/format';
import {isUnavailable} from '@/lib/availability';
import {useCollectionData} from '@/hooks/use-collection-data';
import type {DetailData, Period, PriceContext} from '@/lib/types';

type DetailState = {id: number | null; context: PriceContext; days: Period; onClose: () => void; onPeriod: (days: Period) => void};
const DetailContext = createContext<(DetailState & {data?: DetailData; pending: boolean; error: Error | null}) | null>(null);
function useDetail() {const value = useContext(DetailContext); if (!value) throw new Error('DetailDialog parts must be inside DetailDialog.Root'); return value;}
function Root({children, ...props}: DetailState & {children: ReactNode}) {
  const ready = useCollectionData('randewoo');
  const query = useQuery({...detailOptions(props.id, props.context, props.days),enabled:query => props.id !== null && ready(query)});
  const value = useMemo(() => ({...props, data: query.data, pending: query.isPending, error: query.error}), [props.id, props.context, props.days, props.onClose, props.onPeriod, query.data, query.isPending, query.error]);
  return <DetailContext.Provider value={value}><Dialog open={props.id !== null} onOpenChange={open => {if (!open) props.onClose();}}>{children}</Dialog></DetailContext.Provider>;
}
function Content({children}: {children: ReactNode}) {
  const {data, context, pending, error} = useDetail();
  return <DialogContent id="product-dialog" className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-[850px]">
    <DialogHeader className="dialog-top"><div className="eyebrow" id="detail-brand">{data?.product.brand || 'История цены'}</div><DialogTitle id="detail-name">{data?.product.name || 'Загружаем товар…'}</DialogTitle><DialogDescription id="detail-label">{data ? `${data.product.label} · ${data.product.sku ? 'арт. ' + data.product.sku : 'нет артикула'} · ${context === 'cart' ? 'цена варианта в корзине' : 'публичная цена на сайте'}` : 'Загрузка истории выбранного варианта'}</DialogDescription></DialogHeader>
    {error ? <p role="alert" className="notice">{error.message}</p> : pending ? <p role="status" className="dialog-loading">Загружаем историю…</p> : children}
  </DialogContent>;
}
function Toolbar() {
  const {days, onPeriod, data} = useDetail();
  return <div className="detail-toolbar"><div className="period-tabs" id="period-tabs">{([7, 30, 90, 0] as const).map((period, index) => <Button variant="ghost" key={period} data-days={period} className={days === period ? 'active' : ''} aria-pressed={days === period} onClick={() => onPeriod(period)}>{['Неделя', 'Месяц', '3 месяца', 'Всё время'][index]}</Button>)}</div><a id="detail-link" href={data?.product.url} target="_blank" rel="noopener noreferrer">На Randewoo ↗</a></div>;
}
function Chart() {
  const {data} = useDetail(), points = data?.points || [], valid = points.filter(point => point.price != null);
  return <PriceChart.Root points={points}><PriceChart.ScaleControls detail /><div className="detail-chart-wrap"><PriceChart.Plot id="detail-chart" /></div><p className="detail-note">{valid.length === 1 ? 'Пока сохранена одна реальная цена. История будет расти после следующих проверок.' : valid.length ? `Минимум: ${rub(Math.min(...valid.map(point => point.price!)))} · Максимум: ${rub(Math.max(...valid.map(point => point.price!)))} · Измерений: ${valid.length}` : 'Для этого типа цены пока нет измерений. Данные других объёмов сюда не подставляются.'}</p></PriceChart.Root>;
}
function History() {
  const {data} = useDetail();
  return <div className="detail-table-wrap"><table className="history-table"><thead><tr><th>Проверка</th><th>Цена</th><th>Наличие / результат</th></tr></thead><tbody id="detail-history">{data?.points.toReversed().map((point, index) => <tr key={index}><td>{date(point.checked_at, {second: '2-digit'})}</td><td className={isUnavailable(point) ? 'price-unavailable' : undefined}><strong>{rub(point.price)}</strong></td><td className={isUnavailable(point) ? 'availability-unavailable' : undefined}>{point.status === 'error' ? point.message : point.status === 'missing' ? 'Вариант 1,5 мл не найден' : point.in_stock ? 'В наличии' : 'Нет в наличии'}</td></tr>)}{!data?.points.length && <tr><td colSpan={3} className="empty-state">В этом периоде ещё нет проверок.</td></tr>}</tbody></table></div>;
}
export const DetailDialog = {Root, Content, Toolbar, Chart, History};
