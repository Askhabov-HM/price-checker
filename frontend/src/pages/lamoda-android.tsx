import {useMutation,useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {CollectionNotice} from '@/components/collection-notice';
import {invalidateLamoda,lamodaMutate,lamodaStatusOptions} from '@/lib/lamoda';

const eventNames:Record<string,string> = {
  job_created:'Задание создано',push_accepted:'Push принят Firebase',push_error:'Ошибка отправки push',
  phone_contact:'Телефон запросил задание',no_response:'Телефон не ответил за 10 минут',
  page_received:'Страница получена',phone_error:'Ошибка на телефоне',failed:'Попытка завершилась ошибкой',
  completed:'Данные переданы',expired:'Телефон не завершил задание за 10 минут',ended:'Задание прервано'
};
const stamp = (value:string) => new Date(value).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'medium'});

export function LamodaAndroidPage() {
  const status = useQuery(lamodaStatusOptions);
  const pairing = useMutation({mutationFn:() => lamodaMutate<{url:string;expires_at:string}>('mobile/connect')});
  const revoke = useMutation({mutationFn:() => lamodaMutate('mobile/revoke'),onSuccess:invalidateLamoda});
  const refresh = useMutation({mutationFn:() => lamodaMutate('refresh'),onSuccess:invalidateLamoda});
  const error = status.error || pairing.error || revoke.error || refresh.error;
  return <div><CollectionNotice status={status.data}/><section className="page-heading"><div><div className="eyebrow">LAMODA · ANDROID</div><h1>Сбор с телефона</h1><p>Вход в Lamoda остаётся на вашем Android.</p></div></section>
    <section className="overview-card"><h2>Подключить телефон</h2><p>Установите Lamoda Collector. В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вводить код и адрес сервера не нужно.</p>
      <p>Если вы открыли эту страницу на телефоне, подключиться можно здесь:</p>
      <Button onClick={() => pairing.mutate()} disabled={pairing.isPending}>Подготовить подключение</Button>
      {pairing.data && <p role="status"><a href={pairing.data.url}>Подключить этот Android</a><br/>Ссылка действует 10 минут и заменяет прежнее подключение. Не пересылайте её.</p>}
      <p>{status.data?.mobile?.enabled ? `Подключён: ${status.data.mobile.device?.name}` : 'Телефон ещё не подключён.'}</p>
      {status.data?.mobile?.enabled && status.data.mobile.push && <p>{!status.data.mobile.push.configured
        ? 'Уведомления на телефоне ещё не подключены на сервере.'
        : status.data.mobile.push.error ? 'Не удалось отправить напоминание на телефон. Проверьте уведомления в приложении; Telegram продолжает работать.'
        : status.data.mobile.push.enabled ? 'Напоминания на телефоне подключены. Нажатие уведомления откроет приложение и начнёт сбор.'
        : 'Откройте обновлённое приложение и разрешите уведомления.'}</p>}
      <p>После открытия приложение само перейдёт в избранное и начнёт сбор. Войдите в Lamoda один раз; вход сохраняется между запусками. Держите приложение открытым до завершения. Данные сохраняются в базе Lamoda на VPS после проверки всех страниц.</p>
      {status.data?.mobile?.enabled && <><Button onClick={() => refresh.mutate()} disabled={status.data.running || refresh.isPending}>Обновить избранное</Button>{' '}
        <Button variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}>Отключить телефон</Button></>}
      {status.data?.mobile?.job && <p>Ожидаем Android. Следующая страница: {status.data.mobile.job.next_page}. Откройте приложение на телефоне.</p>}
      <p><a href="/lamoda/android/open">Открыть установленное приложение</a></p>
      {error && <p role="alert" className="notice">{error.message}</p>}
    </section>
    {!!status.data?.mobile?.diagnostics.length && <section className="activity-card"><h2>Журнал Android</h2>
      <p className="small-muted">Время сервера. Состояние экрана известно только при ответе телефона.</p>
      {status.data.mobile.diagnostics.map((entry,index) => <div className="activity-row" key={`${entry.job_id}:${entry.event}:${entry.at}:${index}`}>
        <span className="activity-time">{stamp(entry.at)}</span>
        <span className="activity-message">{entry.job_id.slice(0,8)} · {eventNames[entry.event] || entry.event}{entry.page ? ` · страница ${entry.page}` : ''}
          {entry.reason ? ` · ${entry.reason}` : ''}</span>
        <span>{entry.screen_locked === null ? '' : entry.screen_locked ? 'Заблокирован' : entry.screen_off ? 'Экран выключен' : 'Разблокирован'}</span>
      </div>)}
    </section>}</div>;
}
