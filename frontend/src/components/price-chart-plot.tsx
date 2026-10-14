import {useMemo} from 'react';
import {CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {usePreferences} from '@/lib/store';
import {date, rub} from '@/lib/format';
import type {PricePoint} from '@/lib/types';
import {chartData, useChart} from './price-chart';

export default function Plot({id, small = false}: {id?: string; small?: boolean}) {
  const {points, total} = useChart();
  const scale = usePreferences(state => state.chartScale);
  const {rows, seriesIds} = useMemo(() => chartData(points, scale, total), [points, scale, total]);
  const valid = points.filter(point => point.price != null && Number.isFinite(point.price));
  const label = small ? `${valid.length} измерений цены` : 'История цены';
  if (!valid.length) return <div id={id} className={small ? 'sparkline' : 'chart-empty'} role="img" aria-label={label}>{small ? null : 'Пока нет данных для этого графика'}</div>;
  return <div id={id} className={small ? 'sparkline' : 'price-chart'} role="img" aria-label={label} data-scale={scale}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <LineChart data={rows} margin={small ? {top: 7, right: 4, bottom: 7, left: 4} : {top: 20, right: 24, bottom: 5, left: 10}} accessibilityLayer={!small}>
        {!small && <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 5" vertical={false} />}
        <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} hide={small} minTickGap={50} tick={{fill: 'var(--chart-text)', fontSize: 10}} tickFormatter={value => scale === 'checks' ? `№${Number(value) + 1}` : date(new Date(Number(value)).toISOString())} />
        <YAxis hide={small} width={68} domain={([lo, hi]) => {const margin = Math.max((hi - lo) * .25, hi * .035, 100); return [Math.max(0, lo - margin), hi + margin];}} tick={{fill: 'var(--chart-text)', fontSize: 10}} tickFormatter={value => rub(Number(value))} />
        {!small && <Tooltip content={({active, payload}) => {
          const point = payload?.find(item => item.value != null)?.payload as PricePoint | undefined;
          return active && point ? <div className="chart-tooltip"><strong>{rub(point.price)}</strong><span>{date(point.checked_at, {second: '2-digit'})}</span></div> : null;
        }} />}
        {seriesIds.map(series => <Line key={series} type="linear" dataKey={`series${series}`} stroke="var(--chart-line)" strokeWidth={small ? 1.8 : 2.5} connectNulls={false} isAnimationActive={false} dot={{r: small ? 2.5 : 4, fill: 'var(--chart-line)', stroke: 'var(--chart-point-border)', strokeWidth: small ? 0 : 2}} activeDot={small ? false : {r: 6}} />)}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
