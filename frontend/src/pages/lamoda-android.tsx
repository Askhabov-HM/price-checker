import {useMutation,useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {invalidateLamoda,lamodaMutate,lamodaStatusOptions} from '@/lib/lamoda';

export function LamodaAndroidPage() {
  const status = useQuery(lamodaStatusOptions);
  const pairing = useMutation({mutationFn:() => lamodaMutate<{url:string;expires_at:string}>('mobile/connect')});
  const revoke = useMutation({mutationFn:() => lamodaMutate('mobile/revoke'),onSuccess:invalidateLamoda});
  const refresh = useMutation({mutationFn:() => lamodaMutate('refresh'),onSuccess:invalidateLamoda});
  const error = status.error || pairing.error || revoke.error || refresh.error;
  return <div><section className="page-heading"><div><div className="eyebrow">LAMODA · ANDROID</div><h1>Сбор с телефона</h1><p>Вход в Lamoda остаётся на вашем Android.</p></div></section>
    <section className="overview-card"><h2>Подключить телефон</h2><p>Установите Lamoda Collector. В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вводить код и адрес сервера не нужно.</p>
      <p>Если вы открыли эту страницу на телефоне, подключиться можно здесь:</p>
      <Button onClick={() => pairing.mutate()} disabled={pairing.isPending}>Подготовить подключение</Button>
      {pairing.data && <p role="status"><a href={pairing.data.url}>Подключить этот Android</a><br/>Ссылка действует 10 минут и заменяет прежнее подключение. Не пересылайте её.</p>}
      <p>{status.data?.mobile?.enabled ? `Подключён: ${status.data.mobile.device?.name}` : 'Телефон ещё не подключён.'}</p>
      <p>После открытия приложение само перейдёт в избранное и начнёт сбор. Войдите в Lamoda один раз; вход сохраняется между запусками. Держите приложение открытым до завершения. Данные сохраняются в базе Lamoda на VPS после проверки всех страниц.</p>
      {status.data?.mobile?.enabled && <><Button onClick={() => refresh.mutate()} disabled={status.data.running || refresh.isPending}>Обновить избранное</Button>{' '}
        <Button variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}>Отключить телефон</Button></>}
      {status.data?.mobile?.job && <p>Ожидаем Android. Следующая страница: {status.data.mobile.job.next_page}. Откройте приложение на телефоне.</p>}
      <p><a href="/lamoda/android/open">Открыть установленное приложение</a></p>
      {error && <p role="alert" className="notice">{error.message}</p>}
    </section></div>;
}
