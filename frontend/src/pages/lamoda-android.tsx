import {useMutation,useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {invalidateLamoda,lamodaMutate,lamodaStatusOptions} from '@/lib/lamoda';

export function LamodaAndroidPage() {
  const status = useQuery(lamodaStatusOptions);
  const pairing = useMutation({mutationFn:() => lamodaMutate<{code:string;expires_at:string}>('mobile/pairing')});
  const revoke = useMutation({mutationFn:() => lamodaMutate('mobile/revoke'),onSuccess:invalidateLamoda});
  const refresh = useMutation({mutationFn:() => lamodaMutate('refresh'),onSuccess:invalidateLamoda});
  const error = status.error || pairing.error || revoke.error || refresh.error;
  return <div><section className="page-heading"><div><div className="eyebrow">LAMODA · ANDROID</div><h1>Сбор с телефона</h1><p>Вход в Lamoda остаётся на вашем Android.</p></div></section>
    <section className="overview-card"><h2>Подключить телефон</h2><p>Установите Lamoda Collector, затем введите адрес этого сервера и одноразовый код в настройках приложения.</p>
      <p>Адрес сервера: <strong>{window.location.origin}</strong></p>
      <Button onClick={() => pairing.mutate()} disabled={pairing.isPending}>Создать код подключения</Button>
      {pairing.data && <p role="status">Код: <code style={{overflowWrap:'anywhere',userSelect:'all'}}>{pairing.data.code}</code><br/>Действует 10 минут. Новый телефон заменит прежнее подключение.</p>}
      <p>{status.data?.mobile?.enabled ? `Подключён: ${status.data.mobile.device?.name}` : 'Телефон ещё не подключён.'}</p>
      {status.data?.mobile?.enabled && <><Button onClick={() => refresh.mutate()} disabled={status.data.running || refresh.isPending}>Отправить задание на телефон</Button>{' '}
        <Button variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}>Отключить телефон</Button></>}
      {status.data?.mobile?.job && <p>Ожидаем Android. Следующая страница: {status.data.mobile.job.next_page}. Откройте приложение на телефоне.</p>}
      <p><a href="/lamoda/android/open">Открыть установленное приложение</a></p>
      {error && <p role="alert" className="notice">{error.message}</p>}
    </section></div>;
}
