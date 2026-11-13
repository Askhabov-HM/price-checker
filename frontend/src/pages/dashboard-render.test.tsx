import {QueryClientProvider, useQuery} from '@tanstack/react-query';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {Dashboard} from './dashboard';
import {OzonDashboard} from './ozon';
import {LamodaDashboard} from './lamoda';
import {LamodaDesktopPage} from './lamoda-desktop';
import {useChart} from '@/components/price-chart';
import {queryClient, statusOptions} from '@/lib/api';
import {CollectionDataBoundary, settledRevision, useCollectionDataGate} from '@/hooks/use-collection-data';
import type {DashboardData, ProductRow, Status} from '@/lib/types';
import type {OzonDashboard as OzonData, OzonStatus} from '@/lib/ozon';
import type {LamodaDashboard as LamodaData, LamodaStatus} from '@/lib/lamoda';

const probes = vi.hoisted(() => ({plot:vi.fn(), navigate:vi.fn()}));
vi.mock('@tanstack/react-router', () => ({
  useParams:() => ({listId:'favorites'}),
  useSearch:() => ({context:'public',q:'',filter:'all',sort:'name',changeDays:7,days:30,ozonList:'favorites',price:'listed'}),
  useNavigate:() => probes.navigate,
  Link:({children}:{children:React.ReactNode}) => <span>{children}</span>,
}));
// Keep the real chart boundary/memoization and observe its lazy child. No browser.
vi.mock('@/components/price-chart-plot', () => ({default:function PlotProbe() {
  const {points} = useChart();probes.plot(points);return <span data-testid="chart-probe"/>;
}}));
const status:Status = {running:false,checks:[],schedule:[],schedule_enabled:false,next_check:null,auth_status:'ok',auth_message:'',csrf_token:'test'};
const items:ProductRow[] = Array.from({length:40},(_,index) => ({
  id:index+1,sku:String(index),brand:'Brand',name:`Item ${index}`,label:'1.5 ml',url:'https://randewoo.ru/product/test',image:'',quantity:1,
  status:'ok',price:10000,previous_price:10000,delta:0,last_change:null,minimum:10000,observations:1,in_stock:true,
  checked_at:'2026-11-13T12:00:00Z',price_at:'2026-11-13T12:00:00Z',message:'',watching:false,in_my_cart:false,sparkline:[],
}));
const data:DashboardData = {items,counts:{cart:0,'my-cart':0,favorites:40,watching:0},history:[],status,list:'favorites',context:'public'};
const ozonStatus:OzonStatus = {...status,available:true,configured:true,interval_minutes:30,not_before:null,action_required:false,message:''};
const ozonData:OzonData = {list:'favorites',counts:{favorites:40,cart:0,watching:0},history:[],status:ozonStatus,
  items:items.map(item => ({id:String(item.id),sku:item.sku!,url:item.url,title:item.name,image_url:null,listed_price_kopecks:10000,regular_kopecks:null,ozon_card_kopecks:null,
    seller_id:null,original_price_kopecks:null,seller_name:null,seller_change:null,status:'ok',availability:'available',checked_at:item.checked_at,price_at:item.price_at,message:'',lists:[],sparkline:[]}))};
const lamodaStatus:LamodaStatus = {...ozonStatus,schedule:[],schedule_mode:'interval',browser_available:true,login:{available:true,active:false,required:false,expires_at:null}};
const lamodaData:LamodaData = {history:[],status:lamodaStatus,items:items.map(item => ({id:String(item.id),sku:item.sku!,title:item.name,color:'blue',url:item.url,image_url:null,
  price:10000,original_price:null,checked_at:item.checked_at,price_at:item.price_at,status:'ok',availability:'available',message:'',minimum:10000,observations:1,last_change:null,sparkline:[]}))};

function seed(value:Status=status) {
  queryClient.setDefaultOptions({queries:{retry:false,staleTime:Infinity,gcTime:Infinity}});
  queryClient.setQueryData(['status'],value);
  queryClient.setQueryData(['dashboard','favorites','public'],data);
  queryClient.setQueryData(['ozon','status'],ozonStatus);
  queryClient.setQueryData(['ozon','dashboard','favorites'],ozonData);
  queryClient.setQueryData(['lamoda','status'],lamodaStatus);
  queryClient.setQueryData(['lamoda','dashboard'],lamodaData);
  queryClient.setQueryData(['lamoda','desktop','dashboard'],{...lamodaData,activity:[]});
  probes.plot.mockClear();
}
afterEach(() => {queryClient.clear();vi.unstubAllGlobals();});

it.each([
  ['Randewoo',Dashboard,'История: Brand Item 0'],
  ['Ozon',OzonDashboard,null],
  ['Lamoda',LamodaDashboard,null],
  ['Lamoda desktop',LamodaDesktopPage,null],
] as const)('%s does not rerender table or overview plots when a detail opens', async (_name,Page,label) => {
  seed();vi.stubGlobal('fetch',vi.fn(() => new Promise(() => {})));
  render(<QueryClientProvider client={queryClient}><Page/></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByTestId('chart-probe')).toHaveLength(41));
  const rendered = probes.plot.mock.calls.length;
  fireEvent.click(label ? screen.getByLabelText(label) : screen.getByText('Item 0'));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(probes.plot).toHaveBeenCalledTimes(rendered);
});

it.each(['watching','my-cart'] as const)('%s updates during collection, isolates pending controls, and sends the inverse action on the next click', async list => {
  const running={...status,running:true};seed(running);
  let selected=false,finish:((response:Response)=>void)|undefined;
  const writes:{id:number;active:boolean}[]=[];
  const path=list==='watching'?'/api/watch':'/api/my-cart',field=list==='watching'?'watching':'in_my_cart';
  const addLabel=list==='watching'?'Добавить в наблюдение':'Добавить в мою корзину';
  const removeLabel=list==='watching'?'Убрать из наблюдения':'Убрать из моей корзины';
  vi.stubGlobal('fetch',vi.fn((url:string,options?:RequestInit) => {
    if(url==='/api/status')return Promise.resolve(new Response(JSON.stringify(running)));
    if(url===path) {const body=JSON.parse(String(options?.body));writes.push(body);selected=body.active;return new Promise<Response>(resolve => {finish=resolve;});}
    if(url.startsWith('/api/dashboard'))return Promise.resolve(new Response(JSON.stringify({...data,counts:{...data.counts,[list]:selected?1:0},items:items.map(item=>item.id===1?{...item,[field]:selected}:item)})));
    throw new Error('Unexpected request '+url);
  }));
  function Shell() {
    const {data}=useQuery(statusOptions);
    const ready=useCollectionDataGate('randewoo',!!data,!!data?.running,settledRevision(data));
    return <CollectionDataBoundary value={{randewoo:ready}}><Dashboard/></CollectionDataBoundary>;
  }
  render(<QueryClientProvider client={queryClient}><Shell/></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByTestId('chart-probe')).toHaveLength(41));
  const rendered = probes.plot.mock.calls.length;
  fireEvent.click(screen.getAllByLabelText(addLabel)[0]);
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(screen.getAllByLabelText(addLabel)[0]).toBeDisabled());
  expect(screen.getAllByLabelText(addLabel).slice(1).every(button => !button.hasAttribute('disabled'))).toBe(true);
  expect(probes.plot).toHaveBeenCalledTimes(rendered);
  await act(async () => {finish!(new Response('{"ok":true,"count":1}'));});
  await waitFor(() => expect(screen.getByLabelText(removeLabel)).toBeEnabled());
  expect(screen.getByLabelText(removeLabel)).toHaveAttribute('aria-pressed','true');
  expect(probes.plot).toHaveBeenCalledTimes(rendered);
  fireEvent.click(screen.getByLabelText(removeLabel));
  await waitFor(() => expect(writes).toEqual([{id:1,active:true},{id:1,active:false}]));
  await act(async () => {finish!(new Response('{"ok":true,"count":0}'));});
  await waitFor(() => expect(screen.queryByLabelText(removeLabel)).toBeNull());
});

it('keeps the original membership and exposes a failed write without disabling other rows', async () => {
  seed();
  vi.stubGlobal('fetch',vi.fn((path:string) => Promise.resolve(new Response(JSON.stringify(path==='/api/status'?status:{error:'Не удалось сохранить'}),{status:path==='/api/status'?200:500}))));
  render(<QueryClientProvider client={queryClient}><Dashboard/></QueryClientProvider>);
  fireEvent.click(screen.getAllByLabelText('Добавить в наблюдение')[0]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить');
  expect(screen.queryByLabelText('Убрать из наблюдения')).toBeNull();
  expect(screen.getAllByLabelText('Добавить в наблюдение').every(button=>!button.hasAttribute('disabled'))).toBe(true);
});
