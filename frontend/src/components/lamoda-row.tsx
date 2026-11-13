import {memo} from 'react';
import {PriceChart} from './price-chart';
import {PriceChange} from './product-table';
import {date,rub} from '@/lib/format';
import type {LamodaItem} from '@/lib/lamoda';
import type {ChangePeriod} from '@/lib/types';
const stock:Record<string,string> = {available:'В наличии',unavailable:'Нет в наличии',unknown:'Наличие не подтверждено'};
export const LamodaRow = memo(function LamodaRow({item,changeDays,now,onSelect}: {
  item:LamodaItem; changeDays:ChangePeriod; now:number; onSelect:(id:string)=>void;
}) {
  const unavailable = item.availability === 'unavailable',tone = item.status === 'error' ? 'ozon-error' : unavailable ? 'ozon-price-unavailable' : undefined;
  return <tr><td><button className="ozon-product" onClick={() => onSelect(item.id)}>{item.image_url && <img src={item.image_url} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>{item.sku} · {item.color} · <span className={unavailable ? 'availability-unavailable' : undefined}>{stock[item.availability]}</span></small></span></button></td>
            <td className={tone}><strong>{rub(item.price)}</strong>{unavailable && item.price!==null && <small>Последняя известная · {date(item.price_at)}</small>}</td><td className={tone}>{item.original_price===null ? '—' : <s>{rub(item.original_price)}</s>}</td>
            <td><PriceChange item={item} changeDays={changeDays} nowMs={now} unavailable={unavailable}/></td><td className="ozon-sparkline"><PriceChart.Root points={item.sparkline} total><PriceChart.Plot small/></PriceChart.Root></td>
            <td>{date(item.checked_at)}{item.status==='error' && <small className="ozon-error">{item.message} Цена от {date(item.price_at)}</small>}</td></tr>;
});
