import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {useQueryClient} from '@tanstack/react-query';
export {settledRevision,desktopRevision} from '@/lib/collection-state';

export type DataStore = 'randewoo'|'ozon'|'lamoda'|'desktop';
export const collectionDataKeys = {
  randewoo:[['dashboard'],['detail']],
  ozon:[['ozon','dashboard'],['ozon','detail']],
  lamoda:[['lamoda','dashboard'],['lamoda','detail']],
  desktop:[['lamoda','desktop','dashboard'],['lamoda','desktop','detail']],
} as const;

const DataContext = createContext<Partial<Record<DataStore,boolean>> | null>(null);
export function CollectionDataBoundary({value,children}:{value:Partial<Record<DataStore,boolean>>;children:ReactNode}) {
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export const useCollectionData = (store:DataStore) => useContext(DataContext)?.[store] ?? true;

// One gate per store shell, shared by the table, mini charts and detail dialogs.
// Mark data stale while still disabled, then release every observer together.
// This avoids a fetch on enable followed by another fetch on invalidation.
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
        if (active) setReleased(revision);
      }
    })();
    return () => {active = false;};
  },[client,store,known,running,revision]);
  return known && !running && released === revision;
}
