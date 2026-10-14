import {describe, expect, it} from 'vitest';
import {detectedAgo, hasRecentChange, recentChangeCounts} from './price-changes';
import type {ChangePeriod, ProductRow} from './types';

const nowMs = Date.parse('2026-10-14T12:00:00Z'), day = 86400000;
const row = (ageMs: number, delta = -20000) => ({last_change: {checked_at: new Date(nowMs - ageMs).toISOString(), previous_price: 100000, price: 100000 + delta, delta}} as ProductRow);
describe('recent price events', () => {
  for (const days of [7, 14, 30] as ChangePeriod[]) {
    it(`includes the exact ${days}-day boundary and expires older detections`, () => {
      expect(hasRecentChange(row(days * day), days, nowMs)).toBe(true);
      expect(hasRecentChange(row(days * day + 1), days, nowMs)).toBe(false);
    });
  }
  it('counts only the last real events inside the selected period', () => {
    const rows = [row(2 * day), row(10 * day, 15000), row(20 * day), row(31 * day), row(day, 0), {last_change: null} as ProductRow];
    expect(recentChangeCounts(rows, 7, nowMs)).toEqual({drops: 1, rises: 0});
    expect(recentChangeCounts(rows, 14, nowMs)).toEqual({drops: 1, rises: 1});
    expect(recentChangeCounts(rows, 30, nowMs)).toEqual({drops: 2, rises: 1});
  });
  it('ignores invalid or future timestamps and handles relative detection labels', () => {
    expect(hasRecentChange(row(-1), 7, nowMs)).toBe(false);
    expect(hasRecentChange({last_change: {...row(0).last_change!, checked_at: 'invalid'}} as ProductRow, 7, nowMs)).toBe(false);
    expect(detectedAgo(new Date(nowMs - 2 * day).toISOString(), nowMs)).toBe('2 дня назад');
    expect(detectedAgo(new Date(nowMs).toISOString(), nowMs)).toBe('только что');
  });
});
