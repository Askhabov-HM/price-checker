import {createContext,useCallback,useContext,useEffect,useState,type ReactNode} from 'react';
import {useQueryClient} from '@tanstack/react-query';
export {settledRevision,desktopRevision} from '@/lib/collection-state';

export type DataStore = 'randewoo'|'ozon'|'lamoda'|'desktop';
export const collectionDataKeys = {
  randewoo:[['dashboard'],['detail']],
  ozon:[['ozon','dashboard'],['ozon','detail']],
  lamoda:[['lamoda','dashboard'],['lamoda','detail']],
  desktop:[['lamoda','desktop','dashboard'],['lamoda','desktop','detail']],
} as const;

type CollectionEnabled = (query:{state:{data:unknown}}) => boolean;
const alwaysEnabled:CollectionEnabled = () => true;
const DataContext = createContext<Partial<Record<DataStore,CollectionEnabled>> | null>(null);
export function CollectionDataBoundary({value,children}:{value:Partial<Record<DataStore,CollectionEnabled>>;children:ReactNode}) {
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export const useCollectionData = (store:DataStore) => useContext(DataContext)?.[store] ?? alwaysEnabled;

// One gate per store shell, shared by the table, mini charts and detail dialogs.
// Mark data stale while still disabled, then release every observer together.
// A cold query may load the server's previous result during collection once.
// Cached tables and charts stay frozen until a terminal result.
export function useCollectionDataGate(store:DataStore,known:boolean,running:boolean,revision:string) {
  const client = useQueryClient();
  const [released,setReleased] = useState<string|null>(null);
  useEffect(() => {
    let active = true;
    setReleased(null);
    if (known) void (async () => {
      await Promise.all(collectionDataKeys[store].map(queryKey => client.cancelQueries({queryKey})));
      if (!running) {
        await Promise.all(collectionDataKeys[store].map(queryKey => client.invalidateQueries({queryKey,refetchType:'none'})));
      }
      if (active) setReleased(revision);
    })();
    return () => {active = false;};
  },[client,store,known,running,revision]);
  return useCallback<CollectionEnabled>(query => known && released === revision && (!running || query.state.data === undefined),[known,released,revision,running]);
}
