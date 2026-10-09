// Keep UTC text identical to the original database: lexical comparisons remain valid.
export const now = (value = new Date()) => value.toISOString().slice(0, 19) + '+00:00';
export const moscowDate = (value = new Date()) => new Date(value.getTime() + 3 * 3600000).toISOString().slice(0, 10);

function slots(times, current, offsets) {
  const day = Date.parse(moscowDate(current) + 'T00:00:00+03:00');
  return offsets.flatMap(offset => times.map(value => {
    const [hour, minute] = value.split(':').map(Number);
    return day + offset * 86400000 + hour * 3600000 + minute * 60000;
  }));
}

function moscowTimestamp(value) {
  return new Date(value + 3 * 3600000).toISOString().slice(0, 19) + '+03:00';
}

export function scheduleSlot(times, current = new Date()) {
  const due = slots(times, current, [-1, 0]).filter(value => value <= current.getTime());
  return due.length ? moscowTimestamp(Math.max(...due)) : null;
}

export function nextCheck(times, current = new Date()) {
  const future = slots(times, current, [0, 1]).filter(value => value > current.getTime());
  return future.length ? moscowTimestamp(Math.min(...future)) : null;
}
