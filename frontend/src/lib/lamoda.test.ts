import {expect,it} from 'vitest';
import {selectLamoda,type LamodaItem} from './lamoda';
import {chartData} from '@/components/price-chart';

const now = Date.parse('2026-10-21T10:00:00Z');
const row:LamodaItem = {id:'lamoda:item:SYNTHETIC01',sku:'SYNTHETIC01',title:'Пример Куртка',color:'синий',url:'https://www.lamoda.ru/p/synthetic01/clothes-example/',image_url:null,
  price:140000,original_price:200000,checked_at:'2026-10-21T09:00:00Z',price_at:'2026-10-18T09:00:00Z',status:'ok',availability:'unavailable',message:'',minimum:140000,observations:2,
  last_change:{checked_at:'2026-10-18T09:00:00Z',previous_price:150000,price:140000,delta:-10000},sparkline:[]};
it('Lamoda filters retain unavailable products and distinguish them from errors and minimum prices',() => {
  expect(selectLamoda([row],'синий','unavailable','name',7,now)).toHaveLength(1);
  expect(selectLamoda([row],'','errors','name',7,now)).toHaveLength(0);
  expect(selectLamoda([row],'','minimum','name',7,now)).toHaveLength(0);
  expect(selectLamoda([row],'','drops','name',7,now)).toHaveLength(1);
});
it('Lamoda charts break the line on absence and retain an independent red error marker',() => {
  const points = [
    {checked_at:'2026-10-18T10:00:00Z',price:140000,status:'ok' as const,in_stock:true},
    {checked_at:'2026-10-19T10:00:00Z',price:140000,status:'ok' as const,in_stock:false},
    {checked_at:'2026-10-20T10:00:00Z',price:null,status:'error' as const,in_stock:null},
  ];
  const {rows} = chartData(points,'checks',true);
  expect(rows[1].chartPrice).toBeNull();expect(rows[2].chartPrice).toBeNull();expect(rows[2].errorPrice).toBe(140000);
});
