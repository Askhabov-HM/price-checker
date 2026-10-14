export const labels = {favorites: 'Избранное', cart: 'Корзина', watching: 'Наблюдение'};
export const rub = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(value / 100) + ' ₽';
export const date = (value: string | null | undefined, options: Intl.DateTimeFormatOptions = {}) => value ? new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...options}).format(new Date(value)) : '—';
export function imageUrl(value: string) {
  try {const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.randewoo.ru') ? url.href : undefined;} catch {return undefined;}
}
