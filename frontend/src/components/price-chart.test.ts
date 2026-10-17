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
  it('marks failures at the last known price without filling prices or connecting successful readings', () => {
    const points = [
      {price: 10000, status: 'ok' as const}, {price: null, status: 'error' as const},
      {price: null, status: 'error' as const}, {price: 8000, status: 'ok' as const},
      {price: null, status: 'missing' as const},
    ].map((point, index) => ({...point, checked_at: new Date(1760000000000 + index * 1000).toISOString()}));
    for (const scale of ['time', 'checks'] as const) {
      const {rows, seriesIds} = chartData(points, scale);
      expect(rows.map(row => row.errorPrice)).toEqual([null, 10000, 10000, null, null]);
      expect(rows.map(row => row.price)).toEqual([10000, null, null, 8000, null]);
      expect(rows.map(row => row.chartPrice)).toEqual([10000, null, null, 8000, null]);
      expect(seriesIds).toHaveLength(2);
    }
  });
  it('places failures before any price on a separate baseline and leaves empty history empty', () => {
    const points = [null, null, 8000].map((price, index) => ({price, checked_at: new Date(1760000000000 + index * 1000).toISOString(), status: price == null ? 'error' as const : 'ok' as const}));
    const {rows} = chartData(points, 'checks');
    expect(rows.map(row => row.errorBaseline)).toEqual([0, 0, null]);
    expect(rows.map(row => row.errorPrice)).toEqual([null, null, null]);
    expect(chartData(points.slice(0, 2), 'checks').rows.map(row => row.errorBaseline)).toEqual([0, 0]);
    expect(chartData([], 'checks').rows).toEqual([]);
  });
  it('marks a partial total as a failure without adding it to successful price series', () => {
    const point = {checked_at: '2026-10-11T00:00:00Z', price: 5000, status: 'error' as const};
    const {rows, seriesIds} = chartData([point], 'checks', true);
    expect(rows[0].errorPrice).toBe(5000);
    expect(rows[0].chartPrice).toBeNull();
    expect(seriesIds).toEqual([]);
  });
});
