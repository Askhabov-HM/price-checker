import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRouter,createMemoryHistory,RouterProvider} from '@tanstack/react-router';
import {router as appRouter} from '@/router';
import {displayValue} from '@/lib/storage';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps table filters and page in URL, offers bounded CSV exports, and refreshes the history anchor',async()=>{
 vi.stubGlobal('scrollTo',vi.fn());
 let newest=250;
 const requests:URL[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  const url=new URL(input,'http://localhost');requests.push(url);
  if(url.pathname==='/api/auth')return Response.json({required:true,authenticated:true,login:'owner',csrf_token:'test'});
  if(url.pathname==='/api/storage/overview')return Response.json({stores:[],journal:{ok:false,last:[]},catalogs:{randewoo:{observations:{columns:['id','price','checked_at'],key:'id',date:'checked_at',search:['id'],append:true,filters:{}}}}});
  if(url.pathname==='/api/storage/rows'){
   const page=Number(url.searchParams.get('page')||1),anchor=Number(url.searchParams.get('anchor')||newest);
   return Response.json({columns:['id','price','checked_at'],total:anchor,pages:3,page,size:100,anchor,rows:[{id:anchor-(page-1)*100,price:null,checked_at:'2026-10-29T12:00:00Z'}]});
  }
  return Response.json({error:'unexpected route'},{status:404});
 }));
 const history=createMemoryHistory({initialEntries:['/storage?tab=data&store=randewoo&table=observations']});
 const router=createRouter({routeTree:appRouter.routeTree,history});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);
 const user=userEvent.setup();
 await screen.findByText('Нет данных');
 await waitFor(()=>expect(router.state.location.search).toMatchObject({anchor:'250'}));
 await user.click(screen.getByRole('button',{name:'Далее'}));
 await waitFor(()=>expect(router.state.location.search).toMatchObject({page:'2'}));
 await screen.findByRole('button',{name:'Открыть запись 150'});
 expect(screen.getByRole('link',{name:'CSV: весь результат'}).getAttribute('href')).toContain('scope=all');
 await user.type(screen.getByRole('textbox',{name:'Поиск записей'}),'аромат');await user.click(screen.getByRole('button',{name:'Найти'}));
 await waitFor(()=>expect(requests.some(url=>url.searchParams.get('q')==='аромат'&&url.searchParams.get('page')==='1')).toBe(true));
 newest=260;await user.click(screen.getByRole('button',{name:'Обновить'}));
 await waitFor(()=>expect(router.state.location.search).toMatchObject({anchor:'260'}));
 view.unmount();client.clear();
});
it('preserves unknown values, price units and Moscow time',()=>{
 expect(displayValue('price',null)).toBe('Нет данных');
 expect(displayValue('price',12345)).toBe('123,45');
 expect(displayValue('checked_at','2026-10-29T12:00:00Z')).toContain('15:00:00');
});
