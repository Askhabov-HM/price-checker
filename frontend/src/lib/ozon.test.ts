import {expect,it} from 'vitest';
import {chartData} from '@/components/price-chart';
import {ozonOverviewPoints,ozonProductPoints,type OzonChartPoint,type OzonHistory} from './ozon';

it('keeps both price types independent and breaks the miniature chart on a seller change or error', () => {
  const points: OzonChartPoint[] = ['55','66',null].map((seller,index) => ({checked_at:`2026-10-18T${10+index}:00:00Z`,
    status:index === 2 ? 'error' : 'ok',availability:'available',listed_price_kopecks:index === 2 ? null : 95000,regular_kopecks:index === 2 ? null : 100000,
    ozon_card_kopecks:index === 0 ? 90000 : null,seller_id:seller,message:''}));
  const regular = ozonProductPoints(points,'regular'), card = ozonProductPoints(points,'ozon_card');
  expect(regular.map(point => point.price)).toEqual([100000,100000,null]);
  expect(card.map(point => point.price)).toEqual([90000,null,null]);
  const {rows} = chartData(regular,'checks',true);
  expect(rows[0].series).not.toBe(rows[1].series);
  expect(rows[2].chartPrice).toBeNull();expect(rows[2].errorPrice).toBe(100000);
});

it('shows a failed subtotal as an error marker and never plots a missing price type as zero', () => {
  const history: OzonHistory[] = [{checked_at:'2026-10-18T10:00:00Z',count:30,observed_count:2,message:'Synthetic failure',
    regular:{known_total:100000,priced_count:1,complete:false,status:'error',composition:'synthetic'},
    listed:{known_total:95000,priced_count:1,complete:false,status:'error',composition:'synthetic'},
    ozon_card:{known_total:0,priced_count:0,complete:false,status:'error',composition:'synthetic'}}];
  const regular = ozonOverviewPoints(history,'regular'), card = ozonOverviewPoints(history,'ozon_card');
  expect(regular[0].price).toBe(100000);expect(card[0].price).toBeNull();
  expect(chartData(regular,'time',true).rows[0].chartPrice).toBeNull();
  expect(chartData(regular,'time',true).rows[0].errorPrice).toBe(100000);
  expect(chartData(card,'time',true).rows[0].errorBaseline).toBe(0);
});

it('plots the favorites price without inferring card conditions or breaking on an unknown seller',() => {
  const points: OzonChartPoint[] = ['55',null].map((seller,index) => ({checked_at:`2026-10-18T${10+index}:00:00Z`,
    status:'ok',availability:'unknown',listed_price_kopecks:137300,regular_kopecks:null,ozon_card_kopecks:null,seller_id:seller,message:''}));
  const listed = ozonProductPoints(points,'listed');
  expect(listed.map(point => point.price)).toEqual([137300,137300]);
  expect(listed[0].in_stock).toBeNull();
  expect(chartData(listed,'checks',true).rows.map(row => row.series)).toEqual([0,0]);
});
