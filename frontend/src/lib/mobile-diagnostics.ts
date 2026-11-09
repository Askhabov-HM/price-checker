import type {MobileTimelineEvent} from './lamoda';

export const mobileRuntimeNames:Record<string,string>={idle:'Нет активного задания',queued:'Ожидаем общую очередь',waiting:'Ожидаем телефон',running:'Телефон недавно подтвердил работу',
  silent:'Связь с телефоном потеряна; причина пока неизвестна',completed:'Результат сохранён',failed:'Сбор завершился ошибкой',canceled:'Сбор отменён',expired:'Срок задания истёк',ended:'Задание завершилось'};
const names:Record<string,string>={job_created:'Задание создано',push_accepted:'Push принят Firebase',push_error:'Ошибка отправки push',
  phone_contact:'Телефон запросил задание',no_response:'Телефон не ответил за 10 минут',page_received:'Страница получена',phone_error:'Ошибка на телефоне',
  failed:'Попытка завершилась ошибкой',completed:'Все страницы переданы',expired:'Срок задания истёк',ended:'Задание прервано',
  PROCESS_START:'Запуск процесса',PROCESS_ALIVE:'Процесс жив',PROCESS_EXIT:'Предыдущее завершение процесса',APP_OPEN:'Открыто приложение',
  PUSH_RECEIVED:'Push получен приложением',PUSH_EXPIRED:'Получено устаревшее push-задание',WORK_STATE:'Состояние задачи Android',
  WORK_STARTED:'Задача Android запущена',WORK_STOPPED:'Android остановил задачу',WORK_RETRY:'Запланирован повтор',WORK_SUCCESS:'Работа задачи завершена',
  WORK_REQUEST_MANUAL:'Запрошен ручной сбор',WORK_REQUEST_PUSH:'Push передан в очередь Android',WORK_REQUEST_POLL:'Проверка задания передана Android',
  FOREGROUND_DENIED:'Android отказал в запуске foreground service',PAIR_SAVED:'Подключение сохранено',PAIR_FAILED:'Ошибка подключения',
  PROGRESS:'Ход сбора',HEARTBEAT:'Подтверждение активности',CANCEL_REQUESTED:'Запрошена отмена',CANCEL_PENDING:'Отмена ждёт связи',CANCEL_ACK:'VPS подтвердил результат отмены',
  SOURCE_UNVERIFIED:'Lamoda не подтвердила аккаунт',SOURCE_LOGIN_REQUIRED:'Lamoda требует вход',SOURCE_ACCOUNT_MISMATCH:'Другой аккаунт Lamoda',SOURCE_ERROR:'Ошибка чтения Lamoda',RENDERER_GONE:'WebView завершён Android'};
const stages:Record<string,string>={requesting:'получение задания',reading:'чтение страницы',uploading:'отправка страницы',waiting:'ожидание',finished:'локальная работа завершена',canceling:'отмена'};
const sourceReasons:Record<string,string>={redirect:'перенаправление запроса избранного',http_error:'HTTP-ошибка Lamoda',content_type:'неожиданный тип ответа',
  request_failed:'запрос не выполнен: сеть или блокировка',request_timeout:'тайм-аут запроса',read_canceled:'чтение прервано',response_read:'ошибка чтения ответа',
  response_too_large:'слишком большой ответ',state_too_large:'слишком большой блок данных',html_parse:'ошибка разбора HTML',
  state_script_missing:'нет ожидаемого блока данных Lamoda',state_script_ambiguous:'несколько блоков данных Lamoda',user_state:'не удалось разобрать блок аккаунта',
  payload_state:'не удалось разобрать блок избранного',state_shape:'неожиданная структура избранного',customer_missing:'нет подтверждения аккаунта',
  customer_null:'Lamoda сообщила об отсутствии входа',page_navigation:'страница изменилась во время чтения',context_lost:'потерян контекст страницы',
  native_result:'не получен результат из WebView',page_timeout:'тайм-аут чтения страницы'};
export function mobileEventText(event:MobileTimelineEvent) {
  const parts=[event.event==='API'?`${event.action} · ${event.phase}`:names[event.event]||event.event];
  if(event.page)parts.push(`страница ${event.page}`);
  if(event.stage)parts.push(stages[event.stage]||event.stage);
  if(event.work_state)parts.push(event.work_state);
  if(event.attempt!==undefined)parts.push(`попытка ${event.attempt+1}`);
  if(event.http_status)parts.push(`HTTP ${event.http_status}`);
  if(event.duration_ms!==undefined&&event.phase!=='BEGIN')parts.push(`${event.duration_ms} мс`);
  if(event.issue||event.reason)parts.push(event.issue||event.reason||'');
  if(event.source_reason)parts.push(sourceReasons[event.source_reason]||event.source_reason);
  if(event.outcome)parts.push(event.outcome==='completed'?'результат уже сохранён':event.outcome==='canceled'?'отменено':event.outcome);
  if(event.stop_reason!==undefined)parts.push(`причина остановки Android: ${event.stop_reason}`);
  if(event.exit_reason!==undefined)parts.push(`причина завершения: ${event.exit_reason}, код: ${event.exit_status}`);
  return parts.join(' · ');
}
export function mobileDeliveryDelay(event:MobileTimelineEvent) {
  const delay=Date.parse(event.received_at)-Date.parse(event.event_at);
  return event.source==='phone'&&delay>10000?`доставлено с задержкой ${Math.round(delay/1000)} с`:delay< -10000?'часы телефона опережают VPS':'';
}
