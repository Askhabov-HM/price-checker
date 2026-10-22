import {ValidationError} from './errors.js';
import {nextCheck, scheduleSlot} from './time.js';

export function scheduleSettings(data, previous) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Передайте настройки расписания.');
  const mode = data.schedule_mode ?? previous.schedule_mode;
  const times = data.schedule ?? previous.schedule;
  const minutes = data.interval_minutes ?? previous.interval_minutes;
  if (!['hours','interval'].includes(mode)) throw new ValidationError('Выберите один режим расписания: часы или интервал.');
  if (!Array.isArray(times) || times.length > 25 || times.some(value => typeof value !== 'string' || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(value))) {
    throw new ValidationError('Укажите часы проверок по Москве в формате ЧЧ:ММ.');
  }
  if (![2,30,60,120].includes(minutes)) throw new ValidationError('Выберите интервал: 2 минуты, 30 минут, 1 час или 2 часа.');
  if (typeof data.schedule_enabled !== 'boolean') throw new ValidationError('Укажите состояние автоматических проверок.');
  const schedule = [...new Set(times.map(value => value === '24:00' ? '00:00' : value))].sort();
  if (mode === 'hours' && data.schedule_enabled && !schedule.length) throw new ValidationError('Отметьте хотя бы один час для автоматических проверок.');
  return {schedule_mode:mode,schedule,interval_minutes:minutes,schedule_enabled:data.schedule_enabled};
}

export function scheduledSlot(config, current = new Date()) {
  if (config.schedule_mode === 'hours') return scheduleSlot(config.schedule,current);
  const anchor = Date.parse(config.schedule_anchor), step = config.interval_minutes*60000;
  if (!Number.isFinite(anchor) || current.getTime() < anchor) return null;
  return new Date(anchor+Math.floor((current.getTime()-anchor)/step)*step).toISOString();
}

export function nextScheduledCheck(config, current = new Date()) {
  if (config.schedule_mode === 'hours') return nextCheck(config.schedule,current);
  const anchor = Date.parse(config.schedule_anchor), step = config.interval_minutes*60000;
  if (!Number.isFinite(anchor)) return new Date(current.getTime()+step).toISOString();
  return new Date(current.getTime() < anchor ? anchor : anchor+(Math.floor((current.getTime()-anchor)/step)+1)*step).toISOString();
}
