import {createContext, lazy, Suspense, useContext, useMemo, type ReactNode} from 'react';
import {usePreferences} from '@/lib/store';
import type {ChartScale, PricePoint} from '@/lib/types';
import {Button} from '@/components/ui/button';

export function chartData(points: PricePoint[], scale: ChartScale, total = false) {
  let series = 0;
  let lastPrice: number | null = null;
  const rows = points.map((point, index) => {
    const previous = points[index - 1];
    const failed = point.status === 'error';
    const price = point.price != null && Number.isFinite(point.price) ? point.price : null;
    if (index && (previous.price == null || price == null || previous.status === 'error' || failed || total && previous.composition !== point.composition)) series++;
    const errorPrice = failed ? price ?? lastPrice : null;
    if (!failed && price != null) lastPrice = price;
    return {...point, index, x: scale === 'checks' ? index : new Date(point.checked_at).getTime(), series,
      chartPrice: failed ? null : price, errorPrice, errorBaseline: failed && errorPrice == null ? 0 : null};
  });
  const seriesIds = [...new Set(rows.filter(row => row.chartPrice != null).map(row => row.series))];
  return {rows: rows.map(row => ({...row, ...Object.fromEntries(seriesIds.map(id => [`series${id}`, row.series === id ? row.chartPrice : null]))})), seriesIds};
}

const ChartContext = createContext<{points: PricePoint[]; total: boolean} | null>(null);
export function useChart() {
  const value = useContext(ChartContext);
  if (!value) throw new Error('PriceChart parts must be inside PriceChart.Root');
  return value;
}
function Root({points, total = false, children}: {points: PricePoint[]; total?: boolean; children: ReactNode}) {
  const value = useMemo(() => ({points, total}), [points, total]);
  return <ChartContext.Provider value={value}>{children}</ChartContext.Provider>;
}
function ScaleControls({detail = false}: {detail?: boolean}) {
  const {points} = useChart();
  const {chartScale, setChartScale} = usePreferences();
  return <div className={`chart-toolbar ${detail ? 'detail-scale-toolbar' : ''}`}>
    <div className="chart-scale" role="group" aria-label="Шкала графика">
      {(['time', 'checks'] as const).map(scale => <Button key={scale} type="button" variant="ghost" data-chart-scale={scale} className={chartScale === scale ? 'active' : ''} aria-pressed={chartScale === scale} onClick={() => setChartScale(scale)}>{scale === 'time' ? 'По времени' : 'По проверкам'}</Button>)}
    </div>
    <p className="chart-scale-hint">{chartScale === 'checks' ? 'Проверки расположены равномерно, независимо от времени.' : 'Расстояния соответствуют времени между проверками.'}{points.some(point => point.status === 'error') && ' Красные точки — ошибки проверки.'}</p>
  </div>;
}
const LazyPlot = lazy(() => import('./price-chart-plot'));
function Plot(props: {id?: string; small?: boolean}) {
  return <Suspense fallback={<div className={props.small ? 'sparkline' : 'chart-empty'} role="status">{props.small ? null : 'Загружаем график…'}</div>}><LazyPlot {...props} /></Suspense>;
}
export const PriceChart = {Root, ScaleControls, Plot};
