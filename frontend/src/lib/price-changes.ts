import type {ChangePeriod, ProductRow} from './types';

const day = 86400000;
export function hasRecentChange(item: ProductRow, days: ChangePeriod, nowMs = Date.now()) {
  if (!item.last_change || item.last_change.delta === 0) return false;
  const detected = Date.parse(item.last_change.checked_at);
  return Number.isFinite(detected) && detected <= nowMs && detected >= nowMs - days * day;
}
export function recentChangeCounts(items: ProductRow[], days: ChangePeriod, nowMs = Date.now()) {
  const recent = items.filter(item => hasRecentChange(item, days, nowMs));
  return {drops: recent.filter(item => item.last_change!.delta < 0).length, rises: recent.filter(item => item.last_change!.delta > 0).length};
}
export function detectedAgo(value: string, nowMs = Date.now()) {
  const elapsed = Math.max(0, nowMs - Date.parse(value));
  if (elapsed < 60000) return 'только что';
  const format = new Intl.RelativeTimeFormat('ru', {numeric: 'always'});
  if (elapsed < 3600000) return format.format(-Math.floor(elapsed / 60000), 'minute');
  if (elapsed < day) return format.format(-Math.floor(elapsed / 3600000), 'hour');
  return format.format(-Math.floor(elapsed / day), 'day');
}
