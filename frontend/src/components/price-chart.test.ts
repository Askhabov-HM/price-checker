import {describe, expect, it} from 'vitest';
import {chartData} from './price-chart';

describe('chart scales and gaps', () => {
  it('spaces checks evenly while the time scale preserves actual intervals', () => {
    const points = [0, 1, 60].map((second, index) => ({checked_at: new Date(1760000000000 + second * 1000).toISOString(), price: [10000, 8000, 12000][index]}));
    const time = chartData(points, 'time').rows, checks = chartData(points, 'checks').rows;
    expect((time[1].x - time[0].x) / (time[2].x - time[0].x)).toBeCloseTo(1 / 60);
    expect(checks.map(point => point.x)).toEqual([0, 1, 2]);
    expect(checks.map(point => point.price)).toEqual(time.map(point => point.price));
  });
  it('retains simultaneous checks and breaks lines across errors and composition changes', () => {
    const points = [
      {price: 10000, composition: 'a'}, {price: 9000, composition: 'a'}, {price: null, composition: 'a'},
      {price: 8000, composition: 'b'}, {price: 7000, composition: 'c'},
    ].map(point => ({...point, checked_at: '2026-10-11T13:01:00Z'}));
    const {rows, seriesIds} = chartData(points, 'checks', true);
    expect(rows.map(point => point.x)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0].series).toBe(rows[1].series);
    expect(rows[1].series).not.toBe(rows[3].series);
    expect(rows[3].series).not.toBe(rows[4].series);
    expect(seriesIds).toHaveLength(3);
    expect(new Set(chartData(points, 'time').rows.map(point => point.x)).size).toBe(1);
  });
  it('keeps single readings and excludes errors from drawable series', () => {
    expect(chartData([{checked_at: '2026-10-11T00:00:00Z', price: null}], 'checks').seriesIds).toEqual([]);
    expect(chartData([{checked_at: '2026-10-11T00:00:00Z', price: 10000}], 'time').seriesIds).toHaveLength(1);
  });
});
