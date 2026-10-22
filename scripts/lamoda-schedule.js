import {statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {ValidationError} from '../src/errors.js';

// Administrator command: show the schedule, or explicitly enable the existing
// 30-minute mode. Never start a collector, browser, push sender or scheduler here.
let service;
try {
  const {values} = parseArgs({options:{root:{type:'string'},apply:{type:'boolean',default:false}},allowPositionals:false});
  if (!values.root) throw new ValidationError('Укажите --root с существующей базой Lamoda. Для включения добавьте --apply.');
  const root = resolve(values.root);
  if (!statSync(join(root,'.data/lamoda/prices.sqlite3'),{throwIfNoEntry:false})?.isFile()) {
    throw new ValidationError('База Lamoda не найдена. Новая база не создаётся.');
  }
  service = new LamodaService(root,{logger:() => {},pushSender:{configured:() => false}});
  const summary = state => ({schedule_enabled:state.schedule_enabled,schedule_mode:state.schedule_mode,
    interval_minutes:state.interval_minutes,schedule:state.schedule,schedule_anchor:state.schedule_anchor,
    next_check:state.next_check,not_before:state.not_before,action_required:!!state.action_required});
  const before = summary(service.config());
  if (values.apply && (!service.db.configured() || before.action_required)) throw new ValidationError('Сначала подключите аккаунт Lamoda.');
  const alreadyEnabled = before.schedule_enabled && before.schedule_mode === 'interval' && before.interval_minutes === 30 && !!before.schedule_anchor;
  if (values.apply && !alreadyEnabled) {
    // The same account checks, source pause and stable interval anchor as the web settings.
    service.settings({schedule_enabled:true,schedule_mode:'interval',interval_minutes:30});
  }
  console.log(JSON.stringify({applied:values.apply,changed:values.apply && !alreadyEnabled,before,after:summary(service.config())}));
} catch (error) {
  console.error(error instanceof ValidationError ? error.message : 'Не удалось настроить расписание Lamoda.');
  process.exitCode = 1;
} finally {await service?.close();}
