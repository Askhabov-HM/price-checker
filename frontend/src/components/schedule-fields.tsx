import {Label} from './ui/label';
import type {ScheduleSettings} from '@/lib/types';

const hours = Array.from({length:24},(_,hour) => `${String(hour).padStart(2,'0')}:00`);

export function ScheduleFields({value,onChange,prefix,disabled = false}: {
  value: ScheduleSettings; onChange: (value: ScheduleSettings) => void; prefix: string; disabled?: boolean;
}) {
  const update = (fields: Partial<ScheduleSettings>) => onChange({...value,...fields});
  const toggleHour = (hour: string,checked: boolean) => update({schedule:checked ? [...new Set([...value.schedule,hour])].sort() : value.schedule.filter(time => time !== hour)});
  const extraTimes = value.schedule.filter(time => !hours.includes(time));
  return <fieldset className="schedule-fields" disabled={disabled}>
    <legend>Расписание проверок · Москва</legend>
    <Label className="schedule-enabled"><input id={`${prefix}-schedule-enabled`} type="checkbox" checked={value.schedule_enabled} onChange={event => update({schedule_enabled:event.target.checked})}/> Проверять автоматически</Label>
    <div className="schedule-modes" role="radiogroup" aria-label="Режим расписания">
      <Label><input type="radio" name={`${prefix}-schedule-mode`} value="hours" checked={value.schedule_mode === 'hours'} onChange={() => update({schedule_mode:'hours'})}/> В выбранные часы</Label>
      <Label><input type="radio" name={`${prefix}-schedule-mode`} value="interval" checked={value.schedule_mode === 'interval'} onChange={() => update({schedule_mode:'interval'})}/> С интервалом</Label>
    </div>
    <fieldset className="schedule-option" disabled={value.schedule_mode !== 'hours'}>
      <legend>Часы запуска</legend>
      <div className="schedule-hours">{hours.map(hour => <Label key={hour}><input type="checkbox" checked={value.schedule.includes(hour)} onChange={event => toggleHour(hour,event.target.checked)}/>{hour}</Label>)}</div>
      <p className="small-muted">24:00 — это 00:00 следующих суток: полночь выбирается один раз.</p>
      {!!extraTimes.length && <div className="schedule-legacy"><span>Ранее сохранённое время</span>{extraTimes.map(time => <Label key={time}><input type="checkbox" checked onChange={event => toggleHour(time,event.target.checked)}/>{time}</Label>)}</div>}
    </fieldset>
    <fieldset className="schedule-option" disabled={value.schedule_mode !== 'interval'}>
      <legend>Интервал между запусками</legend>
      <select id={`${prefix}-schedule-interval`} aria-label="Интервал проверок" value={value.interval_minutes} onChange={event => update({interval_minutes:Number(event.target.value) as ScheduleSettings['interval_minutes']})}>
        <option value={2}>Каждые 2 минуты</option><option value={30}>Каждые 30 минут</option><option value={60}>Каждый час</option><option value={120}>Каждые 2 часа</option>
      </select>
    </fieldset>
    <p className="small-muted">Работает только выбранный режим. Магазины проверяются по очереди: если другой сбор занят, запуск подождёт. После перерыва выполняется одна проверка вместо всех пропущенных.</p>
  </fieldset>;
}
