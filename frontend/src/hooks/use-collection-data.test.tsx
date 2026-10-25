import {act,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider,focusManager,useQuery} from '@tanstack/react-query';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CollectionDataBoundary,collectionDataKeys,settledRevision,useCollectionData,useCollectionDataGate} from './use-collection-data';
import {queryClient,invalidatePrices} from '@/lib/api';
import {invalidateOzon} from '@/lib/ozon';
import {invalidateLamoda} from '@/lib/lamoda';

const clients:QueryClient[] = [];
afterEach(() => {for (const client of clients.splice(0)) client.clear();focusManager.setFocused(undefined);});
function client() {const value = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:0,gcTime:Infinity}}});clients.push(value);return value;}

describe('collection data stays frozen until a terminal result',() => {
  it.each(['randewoo','ozon','lamoda','desktop'] as const)('coalesces a fast %s completion and mutation invalidation into one fetch',async store => {
    const cache = queryClient;clients.push(cache);
    const queryKey = store === 'randewoo' ? ['status'] : [store === 'desktop' ? 'lamoda' : store,'status'];
    const invalidate = store === 'randewoo' ? invalidatePrices : store === 'ozon' ? invalidateOzon : invalidateLamoda;
    const result = (id:number) => ({running:false,checks:[{id,status:'success'}],desktop:{job:null,latest:{run_id:String(id)},last_failure_id:0}});
    let status = result(1);
    const fetch = vi.fn(async () => fetch.mock.calls.length);
    function Harness() {
      const {data} = useQuery({queryKey,queryFn:async () => status});
      const revision = store === 'desktop' ? `${data?.desktop.latest.run_id || ''}:0` : settledRevision(data);
      const enabled = useCollectionDataGate(store,!!data,false,revision);
      const table = useQuery({queryKey:collectionDataKeys[store][0],queryFn:fetch,enabled});
      return <div>Read {table.data}</div>;
    }
    render(<QueryClientProvider client={cache}><Harness/></QueryClientProvider>);
    await screen.findByText('Read 1');
    status = result(2);
    await act(async () => {await invalidate();});
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await screen.findByText('Read 2');
    // A membership/settings mutation with the same completed check still refreshes data.
    await act(async () => {await invalidate();});
    await screen.findByText('Read 3');expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['randewoo','ozon','lamoda','desktop'] as const)('freezes %s tables and open details, then fetches once for every outcome',async store => {
    const cache = client(),table = vi.fn(async () => table.mock.calls.length),detail = vi.fn(async () => detail.mock.calls.length);
    function Data() {
      const enabled = useCollectionData(store);
      const a = useQuery({queryKey:collectionDataKeys[store][0],queryFn:table,enabled});
      const b = useQuery({queryKey:[...collectionDataKeys[store][1],'selected'],queryFn:detail,enabled});
      return <div>{a.data}:{b.data}</div>;
    }
    function Harness({id,running,status,completed=0}:{id:number;running:boolean;status:string;completed?:number}) {
      const revision = settledRevision({checks:[{id,status}]});
      const enabled = useCollectionDataGate(store,true,running,revision);
      return <CollectionDataBoundary value={{[store]:enabled}}><span>Progress {completed}</span><Data/></CollectionDataBoundary>;
    }
    const {rerender} = render(<QueryClientProvider client={cache}><Harness id={1} running={false} status="success"/></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('1:1')).toBeInTheDocument());
    for (const [index,outcome] of ['success','partial','error','interrupted'].entries()) {
      const id = index+2,count = index+1;
      rerender(<QueryClientProvider client={cache}><Harness id={id} running status="running" completed={1}/></QueryClientProvider>);
      await act(async () => {await cache.invalidateQueries({queryKey:collectionDataKeys[store][0]});focusManager.setFocused(false);focusManager.setFocused(true);});
      rerender(<QueryClientProvider client={cache}><Harness id={id} running status="running" completed={20}/></QueryClientProvider>);
      expect(screen.getByText('Progress 20')).toBeInTheDocument();expect(screen.getByText(`${count}:${count}`)).toBeInTheDocument();
      expect(table).toHaveBeenCalledTimes(count);expect(detail).toHaveBeenCalledTimes(count);
      rerender(<QueryClientProvider client={cache}><Harness id={id} running={false} status={outcome} completed={20}/></QueryClientProvider>);
      await waitFor(() => expect(screen.getByText(`${count+1}:${count+1}`)).toBeInTheDocument());
      expect(table).toHaveBeenCalledTimes(count+1);expect(detail).toHaveBeenCalledTimes(count+1);
    }
  });

  it.each(['randewoo','ozon','lamoda','desktop'] as const)('loads the previous %s result on first open and new query keys during collection',async store => {
    const cache = client(),fetch = vi.fn(async () => 'Finished data');
    function Harness({known,running,selection='favorites'}:{known:boolean;running:boolean;selection?:string}) {
      const enabled = useCollectionDataGate(store,known,running,running?'1:running':'1:success');
      const data = useQuery({queryKey:[...collectionDataKeys[store][0],selection],queryFn:fetch,enabled});return <div>{data.data}</div>;
    }
    const {rerender} = render(<QueryClientProvider client={cache}><Harness known={false} running={false}/></QueryClientProvider>);
    expect(fetch).not.toHaveBeenCalled();
    rerender(<QueryClientProvider client={cache}><Harness known running/></QueryClientProvider>);
    await screen.findByText('Finished data');expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {await cache.invalidateQueries();focusManager.setFocused(false);focusManager.setFocused(true);});
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<QueryClientProvider client={cache}><Harness known running selection="another-list"/></QueryClientProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    rerender(<QueryClientProvider client={cache}><Harness known running/></QueryClientProvider>);
    await act(async () => {});expect(fetch).toHaveBeenCalledTimes(2);
    rerender(<QueryClientProvider client={cache}><Harness known running={false}/></QueryClientProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it('opens a previously closed detail and changes its period during collection without live refetch',async () => {
    const cache = client(),fetch = vi.fn(async () => 'Previous history');
    function Harness({selected,days}:{selected:string|null;days:number}) {
      const ready = useCollectionDataGate('ozon',true,true,'2:running');
      const data = useQuery({queryKey:['ozon','detail',selected,days],queryFn:fetch,enabled:query => selected !== null && ready(query)});
      return <div>{data.data}</div>;
    }
    const {rerender} = render(<QueryClientProvider client={cache}><Harness selected={null} days={30}/></QueryClientProvider>);
    await act(async () => {});expect(fetch).not.toHaveBeenCalled();
    rerender(<QueryClientProvider client={cache}><Harness selected="123" days={30}/></QueryClientProvider>);
    await screen.findByText('Previous history');expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<QueryClientProvider client={cache}><Harness selected="123" days={0}/></QueryClientProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => {await cache.invalidateQueries();focusManager.setFocused(false);focusManager.setFocused(true);});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels an in-flight response on collection start and does not publish it later',async () => {
    const cache = client();let resolve:((value:string)=>void)|undefined,signal:AbortSignal|undefined;
    const fetch = vi.fn(({signal:input}:{signal:AbortSignal}) => {
      if (fetch.mock.calls.length === 1) {signal = input;return new Promise<string>(done => {resolve = done;});}
      return Promise.resolve(fetch.mock.calls.length === 2 ? 'Previous data' : 'Final data');
    });
    function Harness({running}:{running:boolean}) {
      const enabled = useCollectionDataGate('ozon',true,running,running?'2:running':'2:success');
      const data = useQuery({queryKey:['ozon','dashboard','favorites'],queryFn:fetch,enabled});return <div>{data.data}</div>;
    }
    const {rerender} = render(<QueryClientProvider client={cache}><Harness running={false}/></QueryClientProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender(<QueryClientProvider client={cache}><Harness running/></QueryClientProvider>);
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await screen.findByText('Previous data');
    await act(async () => {resolve?.('Partial data');});expect(screen.queryByText('Partial data')).toBeNull();
    rerender(<QueryClientProvider client={cache}><Harness running={false}/></QueryClientProvider>);
    await screen.findByText('Final data');expect(fetch).toHaveBeenCalledTimes(3);
  });
});
