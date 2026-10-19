import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';
import {useMutation} from '@tanstack/react-query';
import {ShoppingBasket, Star} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {PriceChart} from './price-chart';
import {invalidatePrices, mutate} from '@/lib/api';
import {date, imageUrl, rub} from '@/lib/format';
import {detectedAgo, hasRecentChange} from '@/lib/price-changes';
import {isUnavailable} from '@/lib/availability';
import type {ChangePeriod, Filter, ListId, ProductRow, Sort} from '@/lib/types';

export function selectProducts(items: ProductRow[], search: string, filter: Filter, sort: Sort, changeDays: ChangePeriod = 7, nowMs = Date.now()) {
  const query = search.toLocaleLowerCase('ru');
  const visible = items.filter(item => `${item.brand} ${item.name} ${item.sku || ''}`.toLocaleLowerCase('ru').includes(query)).filter(item =>
    filter === 'all' || filter === 'changed' && hasRecentChange(item, changeDays, nowMs) ||
    filter === 'drops' && hasRecentChange(item, changeDays, nowMs) && item.last_change!.delta < 0 ||
    filter === 'rises' && hasRecentChange(item, changeDays, nowMs) && item.last_change!.delta > 0 ||
    filter === 'minimum' && item.status === 'ok' && item.price != null && item.price === item.minimum && item.observations > 1 ||
    filter === 'unavailable' && (item.in_stock === false || item.status === 'missing') ||
    filter === 'errors' && ['error', 'pending'].includes(item.status));
  const byName = (a: ProductRow, b: ProductRow) => `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`, 'ru');
  return visible.sort((a, b) => {
    if (sort === 'price-asc') return (a.price ?? Infinity) - (b.price ?? Infinity) || byName(a, b);
    if (sort === 'price-desc') return (b.price ?? -Infinity) - (a.price ?? -Infinity) || byName(a, b);
    if (sort === 'delta') return (hasRecentChange(a, changeDays, nowMs) ? a.last_change!.delta : Infinity) - (hasRecentChange(b, changeDays, nowMs) ? b.last_change!.delta : Infinity) || byName(a, b);
    if (sort === 'recent') return (b.last_change ? Date.parse(b.last_change.checked_at) : -Infinity) - (a.last_change ? Date.parse(a.last_change.checked_at) : -Infinity) || byName(a, b);
    return byName(a, b);
  });
}
type TableState = {items: ProductRow[]; list: ListId; search: string; filter: Filter; sort: Sort; changeDays: ChangePeriod; nowMs: number; onChange: (values: Partial<Pick<TableState, 'search' | 'filter' | 'sort' | 'changeDays'>>) => void; onSelect: (id: number) => void};
const TableContext = createContext<(TableState & {visible: ProductRow[]}) | null>(null);
function useTable() {const value = useContext(TableContext); if (!value) throw new Error('ProductTable parts must be inside ProductTable.Root'); return value;}
function Root({children, changeDays = 7, nowMs = Date.now(), list = 'cart', ...props}: Omit<TableState, 'changeDays' | 'nowMs' | 'list'> & {children: ReactNode; changeDays?: ChangePeriod; nowMs?: number; list?: ListId}) {
  const visible = useMemo(() => selectProducts(props.items, props.search, props.filter, props.sort, changeDays, nowMs), [props.items, props.search, props.filter, props.sort, changeDays, nowMs]);
  const value = useMemo(() => ({...props, list, changeDays, nowMs, visible}), [props.items, props.search, props.filter, props.sort, props.onChange, props.onSelect, list, changeDays, nowMs, visible]);
  return <TableContext.Provider value={value}><section className="products-card">{children}</section></TableContext.Provider>;
}
function Toolbar() {
  const {search, filter, sort, changeDays, onChange} = useTable();
  return <ProductFilters {...{search, filter, sort, changeDays, onChange}} />;
}
export function ProductFilters({search, filter, sort, changeDays, onChange, idPrefix = '', searchLabel = 'Поиск товаров', searchPlaceholder = 'Найти аромат или бренд', unavailableLabel = 'Нет в наличии / объёма'}:
  Pick<TableState, 'search' | 'filter' | 'sort' | 'changeDays' | 'onChange'> & {idPrefix?: string; searchLabel?: string; searchPlaceholder?: string; unavailableLabel?: string}) {
  return <div className="toolbar">
    <label className="search"><span>⌕</span><Input id={`${idPrefix}search`} type="search" className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent" placeholder={searchPlaceholder} aria-label={searchLabel} value={search} onChange={event => onChange({search: event.target.value})} /></label>
    <select id={`${idPrefix}filter`} aria-label="Фильтр товаров" value={filter} onChange={event => onChange({filter: event.target.value as Filter})}>{Object.entries({all: 'Все товары', changed: 'Изменились недавно', drops: 'Подешевели', rises: 'Подорожали', minimum: 'Минимальная цена', unavailable: unavailableLabel, errors: 'Нужна проверка'}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <label className="change-period-label"><span>Период изменений</span><select id={`${idPrefix}change-days`} aria-label="Период изменений" value={changeDays} onChange={event => onChange({changeDays: Number(event.target.value) as ChangePeriod})}>{([7, 14, 30] as const).map(days => <option key={days} value={days}>За {days} дней</option>)}</select></label>
    <select id={`${idPrefix}sort`} aria-label="Сортировка товаров" value={sort} onChange={event => onChange({sort: event.target.value as Sort})}>{Object.entries({recent: 'Сначала последние изменения', name: 'По названию', 'price-asc': 'Сначала дешевле', 'price-desc': 'Сначала дороже', delta: 'По снижению цены'}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
  </div>;
}
export function PriceChange({item, changeDays = 7, nowMs = Date.now(), unavailable = false}: {item: Pick<ProductRow, 'status' | 'last_change' | 'observations'>; changeDays?: ChangePeriod; nowMs?: number; unavailable?: boolean}) {
  const statusLabel = item.status === 'error' ? 'Нет свежих данных' : unavailable ? 'Товар недоступен' : item.status === 'missing' ? 'Нет варианта' : item.status === 'pending' ? 'Ожидает проверки' : null;
  const change = item.last_change;
  if (!change) return <span className={unavailable ? 'muted availability-unavailable' : 'muted'}>{statusLabel || (item.observations > 1 ? 'Цена не менялась' : item.observations === 1 ? 'Первая проверка' : 'Нет цен для сравнения')}</span>;
  const recent = hasRecentChange(item, changeDays, nowMs);
  return <div className="last-price-change">
    <span className={`change ${unavailable ? 'unavailable' : recent ? change.delta < 0 ? 'down' : 'up' : 'historic'}`}>{change.delta < 0 ? '↘' : '↗'} {rub(Math.abs(change.delta))}{change.previous_price > 0 && <small>{change.delta > 0 ? '+' : '−'}{(Math.abs(change.delta) / change.previous_price * 100).toFixed(1).replace('.', ',')}%</small>}</span>
    <small className={`change-prices${unavailable ? ' availability-unavailable' : ''}`}>{rub(change.previous_price)} → {rub(change.price)}</small>
    <time dateTime={change.checked_at} title={`Обнаружено ${date(change.checked_at, {year: 'numeric', second: '2-digit'})}`}>Обнаружено {detectedAgo(change.checked_at, nowMs)}</time>
    {statusLabel && <small className={`stale-label${unavailable ? ' availability-unavailable' : ''}`}>{statusLabel}</small>}
  </div>;
}
function ProductImage({item}: {item: ProductRow}) {
  const [failed, setFailed] = useState(false), url = imageUrl(item.image);
  return <div className="product-image">{url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{item.brand.slice(0, 2).toUpperCase()}</span>}</div>;
}
function Rows() {
  const {visible, items, list, onSelect, changeDays, nowMs} = useTable();
  const watch = useMutation({mutationFn: (item: ProductRow) => mutate('/api/watch', {id: item.id, active: !item.watching}), onSuccess: invalidatePrices});
  const personalCart = useMutation({mutationFn: (item: ProductRow) => mutate('/api/my-cart', {id: item.id, active: !item.in_my_cart}), onSuccess: invalidatePrices});
  return <><div className="table-wrap"><table className="products-table"><thead><tr>{['ТОВАР', 'ЦЕНА СЕЙЧАС', 'ПОСЛЕДНЕЕ ИЗМЕНЕНИЕ', 'МИНИМУМ', 'ИСТОРИЯ', 'НАЛИЧИЕ', 'Наблюдение', 'Моя корзина'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody id="product-rows">
    {visible.map(item => <tr key={item.id} data-id={item.id} tabIndex={0} aria-label={`История: ${item.brand} ${item.name}`} onClick={() => onSelect(item.id)} onKeyDown={event => {if (event.target === event.currentTarget && event.key === 'Enter') {event.preventDefault(); onSelect(item.id);}}}>
      <td><div className="product-cell"><ProductImage item={item} /><div className="product-info"><span className="product-brand">{item.brand}</span><strong>{item.name}</strong><small>{item.label} · {item.sku ? `арт. ${item.sku}` : 'артикул уточняется'}</small></div></div></td>
      <td><span className={`price ${isUnavailable(item) ? 'price-unavailable' : item.status === 'error' ? 'stale-price' : ''}`}>{rub(item.price)}</span>{item.status === 'error' && item.price != null && <small className="stale-label">Последняя известная</small>}</td>
      <td><PriceChange item={item} changeDays={changeDays} nowMs={nowMs} unavailable={isUnavailable(item)} /></td><td><span className="minimum">{rub(item.minimum)}</span></td>
      <td><PriceChart.Root points={item.sparkline}><PriceChart.Plot small /></PriceChart.Root><small className="sparkline-label">{item.observations} проверок</small></td>
      <td><span className={`stock ${item.status === 'error' ? 'warning' : item.in_stock ? '' : 'neutral'}`}>{item.status === 'error' ? 'Ошибка проверки' : item.status === 'missing' ? 'Нет варианта 1,5 мл' : item.in_stock == null ? 'Ожидает проверки' : item.in_stock ? 'В наличии' : 'Нет в наличии'}</span></td>
      <td><Button variant="ghost" size="icon" className={`watch-button ${item.watching ? 'selected' : ''}`} aria-label={item.watching ? 'Убрать из наблюдения' : 'Добавить в наблюдение'} disabled={watch.isPending} onClick={event => {event.stopPropagation(); watch.mutate(item);}}><Star size={19} fill={item.watching ? 'currentColor' : 'none'} /></Button></td>
      <td><Button variant="ghost" size="icon" className={`watch-button ${item.in_my_cart ? 'selected' : ''}`} aria-label={item.in_my_cart ? 'Убрать из моей корзины' : 'Добавить в мою корзину'} title={item.in_my_cart ? 'Убрать из моей корзины' : 'Добавить в мою корзину'} aria-pressed={item.in_my_cart} disabled={personalCart.isPending} onClick={event => {event.stopPropagation(); personalCart.mutate(item);}}><ShoppingBasket size={19} /></Button></td>
    </tr>)}
    {!visible.length && <tr><td colSpan={8} className="empty-state"><strong>{items.length ? 'Ничего не найдено' : 'В этом списке пока нет товаров'}</strong><p>{list === 'my-cart' ? 'Выберите товары кнопкой корзины в избранном или добавьте ссылку на аромат.' : 'Добавьте товар в наблюдение или запустите проверку цен.'}</p></td></tr>}
  </tbody></table></div>{(watch.error || personalCart.error) && <p className="notice" role="alert">{personalCart.error?.message || watch.error?.message}</p>}</>;
}
function Summary() {const {visible, items} = useTable(); return <div className="table-footer"><span id="table-summary">Показано {visible.length} из {items.length} товаров</span><span>Цены в рублях · время по Москве</span></div>;}
function Count() {return <span id="visible-count">{useTable().visible.length}</span>;}
export const ProductTable = {Root, Toolbar, Rows, Summary, Count};
