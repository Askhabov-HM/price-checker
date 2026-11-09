import {expect,it} from 'vitest';
import {mobileDeliveryDelay,mobileEventText} from './mobile-diagnostics';
import type {MobileTimelineEvent} from './lamoda';
const base:MobileTimelineEvent={event_id:'example',source:'phone',event:'API',event_at:'2026-11-04T10:00:00Z',received_at:'2026-11-04T10:05:00Z'};

it('explains source failures independently from confirmed logout',()=>{
  expect(mobileEventText({...base,event:'SOURCE_UNVERIFIED',page:1,http_status:200,source_reason:'state_script_missing'}))
    .toContain('страница 1 · HTTP 200 · нет ожидаемого блока данных Lamoda');
  expect(mobileEventText({...base,event:'SOURCE_LOGIN_REQUIRED',source_reason:'customer_null'}))
    .toContain('Lamoda сообщила об отсутствии входа');
});
it('shows transport duration and distinguishes late delivery from activity time',()=>{
  expect(mobileEventText({...base,action:'page',phase:'ERROR',duration_ms:15000,http_status:401,issue:'AUTH',page:2})).toContain('страница 2');
  expect(mobileEventText({...base,phase:'ERROR',duration_ms:15000,issue:'TLS'})).toContain('15000 мс · TLS');
  expect(mobileDeliveryDelay(base)).toContain('300 с');
  expect(mobileDeliveryDelay({...base,source:'server'})).toBe('');
  expect(mobileDeliveryDelay({...base,event_at:'2026-11-04T10:10:00Z'})).toContain('опережают');
});
it('does not describe a completed cancellation acknowledgement as discarded prices',()=>{
  expect(mobileEventText({...base,event:'CANCEL_ACK',outcome:'completed'})).toContain('результат уже сохранён');
  expect(mobileEventText({...base,event:'CANCEL_ACK',outcome:'canceled'})).toContain('отменено');
});
