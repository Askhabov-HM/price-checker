type CollectionResult = {checks?:{id:number;status:string;finished_at?:string|null}[]};
type DesktopResult = {latest?:{run_id:string}|null;last_failure_id?:number};

export function settledRevision(status?:CollectionResult) {
  const check = status?.checks?.[0];
  return check ? `${check.id}:${check.status}:${check.finished_at || ''}` : 'empty';
}
export const desktopRevision = (status?:DesktopResult) => `${status?.latest?.run_id || ''}:${status?.last_failure_id || 0}`;

// A new terminal revision is refreshed by the shared gate after it disables
// observers. Mutations only refetch directly when that revision is unchanged.
export const mutationRefetch = (running:boolean|undefined,before:string,after:string) => running || before !== after ? 'none' as const : 'active' as const;
