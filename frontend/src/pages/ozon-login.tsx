import {useEffect, useRef, useState} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {authOptions, queryClient, request} from '@/lib/api';
import {invalidateOzon, ozonMutate} from '@/lib/ozon';
import type {AuthState} from '@/lib/types';

interface LoginStatus {available: boolean; active: boolean; required: boolean; expires_at: string | null; phone_hint: string | null;}
interface LoginView extends LoginStatus {websocket_path: string; password: string;}
interface RfbClient {scaleViewport: boolean; resizeSession: boolean; disconnect(): void; addEventListener(name: string, listener: () => void): void;}
type RfbConstructor = new (element: HTMLElement, url: string, options: {credentials: {password: string}}) => RfbClient;

export function OzonLoginPage() {
  const screen = useRef<HTMLDivElement>(null);
  const [view,setView] = useState<LoginView | null>(null), [message,setMessage] = useState(''), [screenError,setScreenError] = useState('');
  const status = useQuery({queryKey:['ozon','login'],queryFn:() => request<LoginStatus>('/api/providers/ozon/login/status'),refetchInterval:10000});
  const refresh = () => queryClient.invalidateQueries({queryKey:['ozon','login']});
  const start = useMutation({mutationFn:() => ozonMutate<LoginView>('login/start',{}),onSuccess:result => {
    setMessage('Подключаем окно Ozon…');setView(result);void refresh();
  }});
  const phone = useMutation({mutationFn:() => ozonMutate('login/phone',{}),onSuccess:() => setMessage('Номер подставлен. Запросите код в окне Ozon и введите его там.')});
  const finish = useMutation({mutationFn:() => ozonMutate('login/finish',{}),onSuccess:async () => {
    setView(null);setMessage('Вход сохранён. Можно закрыть эту вкладку.');await invalidateOzon();
  }});
  const cancel = useMutation({mutationFn:() => ozonMutate('login/cancel',{}),onSuccess:() => {
    setView(null);setMessage('Окно Ozon закрыто.');void refresh();
  }});
  useEffect(() => {
    if (!view || !screen.current) return;
    let disposed = false, rfb: RfbClient | undefined;
    setScreenError('');
    const modulePath = '/api/providers/ozon/login/assets/core/rfb.js';
    void import(/* @vite-ignore */ modulePath).then((module: {default: RfbConstructor}) => {
      if (disposed || !screen.current) return;
      const url = new URL(view.websocket_path,location.origin);url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      rfb = new module.default(screen.current,url.href,{credentials:{password:view.password}});
      rfb.scaleViewport = true;rfb.resizeSession = false;
      rfb.addEventListener('connect',() => {if (!disposed) setMessage('Нажмите «Войти» в окне Ozon. Введите телефон и код, затем сохраните вход.');});
      rfb.addEventListener('disconnect',() => {if (!disposed) setScreenError('Соединение с окном закрыто. Откройте его заново, если вход ещё не сохранён.');});
    }).catch(() => {if (!disposed) setScreenError('Не удалось подключить окно Ozon. Попробуйте открыть его заново.');});
    // A normal tab close also attempts to save an already completed login.
    const saveOnClose = () => {
      const token = queryClient.getQueryData<AuthState>(authOptions.queryKey)?.csrf_token;
      if (token) void fetch('/api/providers/ozon/login/finish',{method:'POST',credentials:'same-origin',keepalive:true,
        headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:'{}'}).catch(() => {});
    };
    window.addEventListener('pagehide',saveOnClose);
    return () => {disposed = true;window.removeEventListener('pagehide',saveOnClose);rfb?.disconnect();};
  },[view]);
  const error = start.error || phone.error || finish.error || cancel.error || status.error;
  const pending = start.isPending || phone.isPending || finish.isPending || cancel.isPending;
  return <section className="overview-card">
    <div className="card-heading"><div><h1>Вход в Ozon</h1><p>Войдите в свой аккаунт в окне ниже. Код подтверждения вводится прямо в Ozon.</p></div><a href="/ozon">К избранному</a></div>
    {error && <p role="alert" className="notice">{error.message}</p>}
    {screenError && <p role="alert" className="notice">{screenError}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {!status.isPending && !status.data?.available && <p className="notice">Окно входа пока недоступно на этом сервере.</p>}
    <div className="flex flex-wrap gap-3 py-3">
      {!view && <Button disabled={!status.data?.available || pending} onClick={() => start.mutate()}>{start.isPending ? 'Открываем…' : status.data?.active ? 'Продолжить вход' : 'Открыть Ozon'}</Button>}
      {view && <><Button variant="outline" disabled={pending} onClick={() => phone.mutate()}>Подставить номер {view.phone_hint}</Button>
        <Button disabled={pending} onClick={() => finish.mutate()}>{finish.isPending ? 'Сохраняем…' : 'Сохранить вход'}</Button>
        <Button variant="ghost" disabled={pending} onClick={() => cancel.mutate()}>Отмена</Button></>}
    </div>
    {view && <><div ref={screen} className="h-[65vh] min-h-[400px] overflow-hidden rounded-lg bg-neutral-950"/>
      <p className="small-muted">Окно доступно 20 минут. После входа нажмите «Сохранить вход» — затем эту вкладку можно закрыть.</p></>}
  </section>;
}
