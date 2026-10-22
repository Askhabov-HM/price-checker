import type {CollectionStatus} from '@/lib/types';

const names = {randewoo:'Randewoo',ozon:'Ozon',lamoda:'Lamoda'};
export function CollectionNotice({status}: {status?: CollectionStatus}) {
  if (!status?.queued) return null;
  return <p className="notice" role="status">Проверка ожидает в очереди{status.queue_position ? ` · позиция ${status.queue_position}` : ''}.
    {' '}{status.active_store ? `Сейчас проверяется ${names[status.active_store]}.` : 'Ожидаем освобождения сборщика.'}
    {' '}Предыдущие цены остаются доступны.</p>;
}
