import {useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Button} from '@/components/ui/button';
import {CollectionNotice} from '@/components/collection-notice';
import {invalidateLamoda,lamodaMutate,lamodaStatusOptions,mobileTimelineOptions} from '@/lib/lamoda';
import {mobileRuntimeNames,mobileEventText,mobileDeliveryDelay} from '@/lib/mobile-diagnostics';

const stamp=(value:string)=>new Date(value).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Moscow'});

export function LamodaAndroidPage() {
  const status=useQuery(lamodaStatusOptions),[job,setJob]=useState<string|null>(null);
  const timeline=useQuery(mobileTimelineOptions(job));
  const pairing=useMutation({mutationFn:()=>lamodaMutate<{url:string;expires_at:string}>('mobile/connect')});
  const revoke=useMutation({mutationFn:()=>lamodaMutate('mobile/revoke'),onSuccess:invalidateLamoda});
  const refresh=useMutation({mutationFn:()=>lamodaMutate('refresh'),onSuccess:invalidateLamoda});
  const error=status.error||pairing.error||revoke.error||refresh.error||timeline.error;
  const mobile=status.data?.mobile,runtime=mobile?.runtime;
  const jobs=[...new Set([job,...(mobile?.diagnostics.map(event=>event.job_id)||[]),...(timeline.data?.events.map(event=>event.job_id)||[])].filter((value):value is string=>!!value))];
  return <div><CollectionNotice status={status.data}/><section className="page-heading"><div><div className="eyebrow">LAMODA · ANDROID</div><h1>Сбор с телефона</h1><p>Вход в Lamoda остаётся на вашем Android.</p></div></section>
    <section className="overview-card"><h2>Подключить телефон</h2><p>Установите Lamoda Collector. В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вводить код и адрес сервера не нужно.</p>
      <p>Если вы открыли эту страницу на телефоне, подключиться можно здесь:</p>
      <Button onClick={()=>pairing.mutate()} disabled={pairing.isPending}>Подготовить подключение</Button>
      {pairing.data&&<p role="status"><a href={pairing.data.url}>Подключить этот Android</a><br/>Ссылка действует 10 минут и заменяет прежнее подключение. Не пересылайте её.</p>}
      <p>{mobile?.enabled?`Подключён: ${mobile.device?.name}`:'Телефон ещё не подключён.'}</p>
      {mobile?.enabled&&mobile.push&&<p>{!mobile.push.configured?'Firebase ещё не настроен на сервере.':mobile.push.error?'Не удалось отправить push. Откройте приложение; Telegram продолжает работать.':mobile.push.enabled?'Push подключён. Принятие сообщения Firebase не означает запуск сбора на телефоне.':'Откройте приложение и разрешите уведомления.'}</p>}
      <p>Войдите в Lamoda один раз. Android выполняет сбор в фоне, но может задерживать его запуск. Результат сохраняется после получения всех страниц и проверки аккаунта.</p>
      {mobile?.enabled&&<><Button onClick={()=>refresh.mutate()} disabled={status.data?.running||refresh.isPending}>Обновить избранное</Button>{' '}<Button variant="outline" onClick={()=>revoke.mutate()} disabled={revoke.isPending}>Отключить телефон</Button></>}
      {runtime&&<div role="status"><p><strong>{mobileRuntimeNames[runtime.state]||runtime.state}</strong>{runtime.job_id?` · задание ${runtime.job_id}`:''}</p>
        {runtime.last_contact&&<p>Последнее подтверждение работы: {stamp(runtime.last_contact)} МСК.{runtime.next_page?` Следующая страница: ${runtime.next_page}.`:''}</p>}
        {runtime.state==='silent'&&<p>Телефон мог потерять сеть или быть остановлен Android. Отсутствие ответа само по себе не подтверждает завершение процесса.</p>}</div>}
      <p><a href="/lamoda/android/open">Открыть установленное приложение</a></p>
      {error&&<p role="alert" className="notice">{error.message}</p>}
    </section>
    <section className="activity-card"><div className="card-heading"><h2>Временная шкала Android</h2><label>Задание{' '}<select aria-label="Фильтр задания Android" value={job||''} onChange={event=>setJob(event.target.value||null)}><option value="">Все события</option>{jobs.map(id=><option key={id} value={id}>{id}</option>)}</select></label></div>
      <p className="small-muted">Время МСК. Для телефона отдельно показаны время события и время получения VPS. События без интернета появятся после доставки журнала.</p>
      {!timeline.data?.events.length&&<p className="activity-empty">Событий пока нет.</p>}
      {timeline.data?.events.map(entry=><div className="activity-row" key={`${entry.source}:${entry.event_id}`}>
        <span className="activity-time">{stamp(entry.event_at)}<br/><small>{entry.source==='phone'?`Получено: ${stamp(entry.received_at)}`:'Событие VPS'}</small></span>
        <span className="activity-message">{entry.job_id?`${entry.job_id.slice(0,8)} · `:entry.run_id?`запуск ${entry.run_id.slice(0,8)} · `:''}{mobileEventText(entry)}
          {mobileDeliveryDelay(entry)&&<><br/><small>{mobileDeliveryDelay(entry)}</small></>}
          {entry.exit_at&&<><br/><small>Процесс завершился: {stamp(entry.exit_at)}</small></>}
          {entry.next_run_at&&<><br/><small>Следующий запуск Android: {stamp(entry.next_run_at)}</small></>}
          {!!entry.dropped_events&&<><br/><small>Телефон удалил по лимиту неотправленные события: {entry.dropped_events}.</small></>}
        </span>
        <span>{entry.screen_locked===null||entry.screen_locked===undefined?'':entry.screen_locked?'Заблокирован':entry.screen_off?'Экран выключен':'Разблокирован'}
          {entry.network_validated!==undefined&&<><br/>{entry.network_validated?'Сеть доступна':'Сеть не подтверждена'}</>}
          {entry.idle&&<><br/>Doze</>}{entry.battery_saver&&<><br/>Энергосбережение</>}{entry.background_restricted&&<><br/>Фон ограничен</>}
        </span>
      </div>)}
    </section></div>;
}
