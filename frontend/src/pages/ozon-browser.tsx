import {useEffect, useState} from 'react';
import {Link, useSearch} from '@tanstack/react-router';
import {useQuery} from '@tanstack/react-query';
import {Monitor, Pause, Play, RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {queryClient, request} from '@/lib/api';

interface Snapshot {captured_at: string; url: string | null; title: string; ready_state: string; image: string | null;}
interface BrowserState {
  available: boolean; running: boolean | null; mode: string; checked_at: string; started_at: string | null;
  snapshot: Snapshot | null;
  last_error: {at: string; outcome: string; http_status: number | null; snapshot: Snapshot | null} | null;
}
const queryKey = ['ozon','browser'];
const modes: Record<string,string> = {
  idle:'Браузер открыт',collecting:'Идёт сбор избранного',starting:'Браузер запускается',login:'Открыто окно входа',
  stopped:'Браузер закрыт',blank:'Браузер открыт · Пустая вкладка',unresponsive:'Страница не отвечает',unavailable:'Нет связи со службой браузера',
};
const outcomes: Record<string,string> = {
  access_limited:'Ozon ограничил доступ',login_required:'Нужен вход в Ozon',rate_limited:'Ozon ограничил частоту запросов',
  http_error:'Ошибка ответа Ozon',network_error:'Ошибка соединения',response_too_large:'Ответ Ozon слишком большой',
  unexpected_content:'Неожиданный ответ Ozon',browser_error:'Ошибка браузера',
};
const time = (value: string) => new Intl.DateTimeFormat('ru-RU',{
  timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
}).format(new Date(value));

export function OzonBrowserPage() {
  const search = useSearch({from:'__root__'});
  const [visible,setVisible] = useState(() => document.visibilityState === 'visible');
  const [automatic,setAutomatic] = useState(true), [historical,setHistorical] = useState(false);
  useEffect(() => {
    const changed = () => {
      const shown = document.visibilityState === 'visible';setVisible(shown);
      if (!shown) void queryClient.cancelQueries({queryKey});
    };
    document.addEventListener('visibilitychange',changed);
    return () => document.removeEventListener('visibilitychange',changed);
  },[]);
  const view = useQuery({queryKey,queryFn:({signal}) => request<BrowserState>('/api/providers/ozon/browser',{signal}),
    enabled:visible && automatic,refetchInterval:visible && automatic ? 5000 : false,
    refetchIntervalInBackground:false,refetchOnWindowFocus:false,refetchOnReconnect:false,retry:false,gcTime:0});
  const state = view.data, failure = state?.last_error;
  const snapshot = historical ? failure?.snapshot : state?.snapshot;
  const fresh = !!state?.available && !view.isError;
  const healthy = fresh && state.running === true && !['unresponsive','login'].includes(state.mode);
  const status = view.isError ? 'Не удалось обновить состояние' : state ? modes[state.mode] || modes.unavailable : 'Получаем состояние…';
  return <section className="overview-card">
    <div className="card-heading flex-wrap"><div><h1>Браузер Ozon</h1><p>Текущее состояние и снимок при последней ошибке. Время указано по Москве.</p></div>
      <Link to="/ozon" search={{...search,ozonList:'favorites',price:'listed'}}>К избранному</Link></div>
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="status" className="flex items-center gap-3"><span className={`size-2.5 shrink-0 rounded-full ${healthy ? 'bg-emerald-500' : fresh && state?.mode === 'starting' ? 'bg-amber-500' : 'bg-slate-400'}`}/>
          <div><p className="text-sm font-medium">{status}</p><p className="mt-1 text-xs text-muted-foreground">
            {state && <>Состояние получено {time(state.checked_at)} · </>}{automatic && visible ? 'Обновление каждые 5 секунд' : 'Обновление приостановлено'}
          </p></div></div>
        <div className="flex gap-2"><Button variant="outline" size="sm" aria-pressed={!automatic} onClick={() => setAutomatic(value => !value)}>
          {automatic ? <Pause/> : <Play/>}{automatic ? 'Пауза' : 'Продолжить'}</Button>
          <Button variant="outline" size="sm" disabled={view.isFetching || !visible} onClick={() => void view.refetch()}><RefreshCw className={view.isFetching ? 'animate-spin' : ''}/>Обновить</Button></div>
      </div>
      {view.error && <p role="alert" className="text-sm text-destructive">{view.error.message}. Показанные ранее кадры могут быть устаревшими.</p>}
      <div className="flex flex-wrap gap-2" aria-label="Выбор снимка"><Button size="sm" variant={!historical ? 'secondary' : 'ghost'} aria-pressed={!historical} onClick={() => setHistorical(false)}>Сейчас</Button>
        <Button size="sm" variant={historical ? 'secondary' : 'ghost'} aria-pressed={historical} onClick={() => setHistorical(true)}>При последней ошибке</Button></div>
      {historical && <div className="rounded-lg border p-4 text-sm">
        {failure ? <><p className="font-medium">{outcomes[failure.outcome] || 'Ошибка сбора'}{failure.http_status ? ` · HTTP ${failure.http_status}` : ''}</p>
          <p className="mt-1 text-xs text-muted-foreground">{time(failure.at)} · Сохранённый снимок, текущее состояние могло измениться.</p></>
          : <p className="text-muted-foreground">{fresh ? 'Снимок появится при следующей ошибке сбора. Кадры прошлых сбоев не записывались.' : 'Сохранённый снимок недоступен, пока нет связи со службой браузера.'}</p>}
      </div>}
      {!historical && state?.mode === 'collecting' && <p className="text-sm text-muted-foreground">Сбор выполняется. Если кадр уже получен, ниже показан последний снимок до сбора; новый появится после завершения.</p>}
      {!historical && state?.mode === 'login' && <p className="text-sm text-muted-foreground">Окно входа доступно на <Link to="/ozon/login" search={search} className="underline">странице входа</Link>. Его содержимое здесь не записывается.</p>}
      {!historical && state?.mode === 'blank' && <p className="text-sm text-muted-foreground">Сейчас открыта пустая вкладка about:blank. При запуске браузерная служба открывает избранное Ozon; здесь отображается её фактическое состояние.</p>}
      {snapshot && <div className="min-w-0 rounded-lg border bg-muted/30 px-4 py-3">
        <p className="break-words text-sm font-medium">{snapshot.title || (snapshot.url === 'about:blank' ? 'Пустая вкладка' : 'Страница без заголовка')}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">{snapshot.url || 'Адрес страницы недоступен'}</p>
        <p className="mt-2 text-xs text-muted-foreground">Кадр сделан {time(snapshot.captured_at)}{snapshot.ready_state === 'complete' ? ' · Страница загружена' : snapshot.ready_state === 'loading' ? ' · Страница загружается' : ''}</p>
      </div>}
      {snapshot?.image ? <div className="overflow-auto rounded-lg border bg-neutral-950"><img className="mx-auto block h-auto max-w-full" src={`data:image/jpeg;base64,${snapshot.image}`} alt={historical ? 'Страница Ozon в момент последней ошибки сбора' : 'Последний снимок страницы в серверном браузере Ozon'}/></div>
        : <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center text-muted-foreground"><Monitor size={32}/>
          <p className="text-sm">{view.isPending && !historical ? 'Получаем снимок…' : 'Снимок страницы пока недоступен'}</p>
          <p className="max-w-md text-xs">{historical ? 'При сбое браузер мог не успеть ответить.' : 'Браузер мог быть закрыт или не ответить на запрос снимка. Попробуйте обновить состояние.'}</p></div>}
      <p className="text-xs text-muted-foreground">Просмотр не меняет страницу Ozon. В скрытой или закрытой вкладке новые кадры не запрашиваются.</p>
    </div>
  </section>;
}
