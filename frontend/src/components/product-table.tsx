import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Star} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {PriceChart} from './price-chart';
import {invalidatePrices, mutate} from '@/lib/api';
import {imageUrl, rub} from '@/lib/format';
import type {Filter, ProductRow, Sort} from '@/lib/types';

export function selectProducts(items: ProductRow[], search: string, filter: Filter, sort: Sort) {
  const query = search.toLocaleLowerCase('ru');
  const visible = items.filter(item => `${item.brand} ${item.name} ${item.sku || ''}`.toLocaleLowerCase('ru').includes(query)).filter(item =>
    filter === 'all' || filter === 'drops' && item.status === 'ok' && item.delta != null && item.delta < 0 ||
    filter === 'rises' && item.status === 'ok' && item.delta != null && item.delta > 0 ||
    filter === 'minimum' && item.status === 'ok' && item.price != null && item.price === item.minimum && item.observations > 1 ||
    filter === 'unavailable' && (item.in_stock === false || item.status === 'missing') ||
    filter === 'errors' && ['error', 'pending'].includes(item.status));
  return visible.sort((a, b) => sort === 'price-asc' ? (a.price ?? Infinity) - (b.price ?? Infinity) : sort === 'price-desc' ? (b.price ?? -Infinity) - (a.price ?? -Infinity) : sort === 'delta' ? (a.delta ?? Infinity) - (b.delta ?? Infinity) : `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`, 'ru'));
}
type TableState = {items: ProductRow[]; search: string; filter: Filter; sort: Sort; onChange: (values: Partial<Pick<TableState, 'search' | 'filter' | 'sort'>>) => void; onSelect: (id: number) => void};
const TableContext = createContext<(TableState & {visible: ProductRow[]}) | null>(null);
function useTable() {const value = useContext(TableContext); if (!value) throw new Error('ProductTable parts must be inside ProductTable.Root'); return value;}
function Root({children, ...props}: TableState & {children: ReactNode}) {
  const visible = useMemo(() => selectProducts(props.items, props.search, props.filter, props.sort), [props.items, props.search, props.filter, props.sort]);
  const value = useMemo(() => ({...props, visible}), [props.items, props.search, props.filter, props.sort, props.onChange, props.onSelect, visible]);
  return <TableContext.Provider value={value}><section className="products-card">{children}</section></TableContext.Provider>;
}
function Toolbar() {
  const {search, filter, sort, onChange} = useTable();
  return <div className="toolbar">
    <label className="search"><span>⌕</span><Input id="search" type="search" className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent" placeholder="Найти аромат или бренд" aria-label="Поиск товаров" value={search} onChange={event => onChange({search: event.target.value})} /></label>
    <select id="filter" aria-label="Фильтр товаров" value={filter} onChange={event => onChange({filter: event.target.value as Filter})}>{Object.entries({all: 'Все товары', drops: 'Подешевели', rises: 'Подорожали', minimum: 'Минимальная цена', unavailable: 'Нет в наличии / объёма', errors: 'Нужна проверка'}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <select id="sort" aria-label="Сортировка товаров" value={sort} onChange={event => onChange({sort: event.target.value as Sort})}>{Object.entries({name: 'По названию', 'price-asc': 'Сначала дешевле', 'price-desc': 'Сначала дороже', delta: 'По снижению цены'}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
  </div>;
}
export function PriceChange({item}: {item: ProductRow}) {
  if (item.status !== 'ok') return <span className="muted">{item.status === 'error' ? 'Нет свежих данных' : item.status === 'missing' ? 'Нет варианта' : 'Ожидает проверки'}</span>;
  if (item.delta == null) return <span className="muted">Первая проверка</span>;
  if (item.delta === 0) return <span className="unchanged">— Без изменений</span>;
  return <span className={`change ${item.delta < 0 ? 'down' : 'up'}`}>{item.delta < 0 ? '↘' : '↗'} {rub(Math.abs(item.delta))}<small>{item.delta > 0 ? '+' : '−'}{item.previous_price ? (Math.abs(item.delta) / item.previous_price * 100).toFixed(1).replace('.', ',') + '%' : ''}</small></span>;
}
function ProductImage({item}: {item: ProductRow}) {
  const [failed, setFailed] = useState(false), url = imageUrl(item.image);
  return <div className="product-image">{url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{item.brand.slice(0, 2).toUpperCase()}</span>}</div>;
}
function Rows() {
  const {visible, items, onSelect} = useTable();
  const watch = useMutation({mutationFn: (item: ProductRow) => mutate('/api/watch', {id: item.id, active: !item.watching}), onSuccess: invalidatePrices});
  return <><div className="table-wrap"><table className="products-table"><thead><tr>{['ТОВАР', 'ЦЕНА СЕЙЧАС', 'ИЗМЕНЕНИЕ', 'МИНИМУМ', 'ИСТОРИЯ', 'НАЛИЧИЕ', 'Наблюдение'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody id="product-rows">
    {visible.map(item => <tr key={item.id} data-id={item.id} tabIndex={0} aria-label={`История: ${item.brand} ${item.name}`} onClick={() => onSelect(item.id)} onKeyDown={event => {if (event.target === event.currentTarget && event.key === 'Enter') {event.preventDefault(); onSelect(item.id);}}}>
      <td><div className="product-cell"><ProductImage item={item} /><div className="product-info"><span className="product-brand">{item.brand}</span><strong>{item.name}</strong><small>{item.label} · {item.sku ? `арт. ${item.sku}` : 'артикул уточняется'}</small></div></div></td>
      <td><span className={`price ${item.status === 'error' ? 'stale-price' : ''}`}>{rub(item.price)}</span>{item.status === 'error' && item.price != null && <small className="stale-label">Последняя известная</small>}</td>
      <td><PriceChange item={item} /></td><td><span className="minimum">{rub(item.minimum)}</span></td>
      <td><PriceChart.Root points={item.sparkline}><PriceChart.Plot small /></PriceChart.Root><small className="sparkline-label">{item.observations} проверок</small></td>
      <td><span className={`stock ${item.status === 'error' ? 'warning' : item.in_stock ? '' : 'neutral'}`}>{item.status === 'error' ? 'Ошибка проверки' : item.status === 'missing' ? 'Нет варианта 1,5 мл' : item.in_stock == null ? 'Ожидает проверки' : item.in_stock ? 'В наличии' : 'Нет в наличии'}</span></td>
      <td><Button variant="ghost" size="icon" className={`watch-button ${item.watching ? 'selected' : ''}`} aria-label={item.watching ? 'Убрать из наблюдения' : 'Добавить в наблюдение'} disabled={watch.isPending} onClick={event => {event.stopPropagation(); watch.mutate(item);}}><Star size={19} fill={item.watching ? 'currentColor' : 'none'} /></Button></td>
    </tr>)}
    {!visible.length && <tr><td colSpan={7} className="empty-state"><strong>{items.length ? 'Ничего не найдено' : 'В этом списке пока нет товаров'}</strong><p>Добавьте товар в наблюдение или запустите проверку цен.</p></td></tr>}
  </tbody></table></div>{watch.error && <p className="notice" role="alert">{watch.error.message}</p>}</>;
}
function Summary() {const {visible, items} = useTable(); return <div className="table-footer"><span id="table-summary">Показано {visible.length} из {items.length} товаров</span><span>Цены в рублях · время по Москве</span></div>;}
function Count() {return <span id="visible-count">{useTable().visible.length}</span>;}
export const ProductTable = {Root, Toolbar, Rows, Summary, Count};
