import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {request,queryClient} from '@/lib/api';
import {invalidateLamoda,lamodaMutate} from '@/lib/lamoda';

interface LoginStatus {available:boolean;active:boolean;required:boolean;expires_at:string|null;}
interface LoginView extends LoginStatus {password:string;websocket_path:string;}
interface Rfb {scaleViewport:boolean;resizeSession:boolean;disconnect():void;addEventListener(name:string,listener:()=>void):void;}
type RfbConstructor = new (element:HTMLElement,url:string,options:{credentials:{password:string}}) => Rfb;
export function LamodaLoginPage() {
  const screen = useRef<HTMLDivElement>(null),[view,setView] = useState<LoginView|null>(null),[message,setMessage] = useState(''),[screenError,setScreenError] = useState('');
  const status = useQuery({queryKey:['lamoda','login'],queryFn:() => request<LoginStatus>('/api/providers/lamoda/login/status'),refetchInterval:10000});
  const start = useMutation({mutationFn:() => lamodaMutate<LoginView>('login/start'),onSuccess:result => {setView(result);setMessage('Подключаем окно Lamoda…');}});
  const finish = useMutation({mutationFn:() => lamodaMutate('login/finish'),onSuccess:async () => {setView(null);setMessage('Вход подтверждён и сохранён.');await invalidateLamoda();}});
  const cancel = useMutation({mutationFn:() => lamodaMutate('login/cancel'),onSuccess:async () => {setView(null);setMessage('Окно входа закрыто.');await queryClient.invalidateQueries({queryKey:['lamoda','login']});}});
  useEffect(() => {
    if (!view || !screen.current) return;
    let disposed = false,rfb:Rfb|undefined;setScreenError('');
    const modulePath = '/api/providers/lamoda/login/assets/core/rfb.js';
    void import(/* @vite-ignore */ modulePath).then((module:{default:RfbConstructor}) => {
      if (disposed || !screen.current) return;
      const url = new URL(view.websocket_path,location.origin);url.protocol = location.protocol==='https:' ? 'wss:' : 'ws:';
      rfb = new module.default(screen.current,url.href,{credentials:{password:view.password}});rfb.scaleViewport = true;rfb.resizeSession = false;
      rfb.addEventListener('connect',() => {if (!disposed) setMessage('Войдите в нужный аккаунт в окне Lamoda, затем нажмите «Сохранить вход».');});
      rfb.addEventListener('disconnect',() => {if (!disposed) setScreenError('Соединение с окном закрыто. При необходимости откройте его заново.');});
    }).catch(() => {if (!disposed) setScreenError('Не удалось подключить окно Lamoda.');});
    return () => {disposed = true;rfb?.disconnect();};
  },[view]);
  const error = start.error || finish.error || cancel.error || status.error,pending = start.isPending || finish.isPending || cancel.isPending;
  return <section className="overview-card"><div className="card-heading"><div><h1>Вход в Lamoda</h1><p>Телефон, пароль и код вводятся прямо в окне магазина.</p></div><a href="/lamoda">К избранному</a></div>
    {error && <p role="alert" className="notice">{error.message}</p>}{screenError && <p role="alert" className="notice">{screenError}</p>}{message && <p role="status" className="notice">{message}</p>}
    {!status.isPending && !status.data?.available && <p className="notice">Окно входа временно недоступно.</p>}
    <div className="flex flex-wrap gap-3 py-3">{!view ? <Button disabled={pending || !status.data?.available} onClick={() => start.mutate()}>{start.isPending ? 'Открываем…' : status.data?.active ? 'Продолжить вход' : 'Открыть Lamoda'}</Button>
      : <><Button disabled={pending} onClick={() => finish.mutate()}>{finish.isPending ? 'Сохраняем…' : 'Сохранить вход'}</Button><Button variant="ghost" disabled={pending} onClick={() => cancel.mutate()}>Отмена</Button></>}</div>
    {view && <><div ref={screen} className="h-[65vh] min-h-[400px] overflow-hidden rounded-lg bg-neutral-950"/><p className="small-muted">Окно доступно 20 минут. После подтверждения входа оно закроется.</p></>}
  </section>;
}
