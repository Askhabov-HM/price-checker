import {cloneElement, type ReactElement} from 'react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach,describe, expect, it, vi} from 'vitest';
import {PriceChart} from './price-chart';
import Plot from './price-chart-plot';
import {usePreferences} from '@/lib/store';
import type {PricePoint} from '@/lib/types';

// jsdom has no layout. Give the real Recharts chart a fixed viewport; no browser is launched.
vi.mock('recharts', async importOriginal => ({
  ...await importOriginal<typeof import('recharts')>(),
  ResponsiveContainer: ({children}: {children: ReactElement<{width: number; height: number}>}) => cloneElement(children, {width: 800, height: 300}),
}));

describe('compact chart rendering in jsdom', () => {
  afterEach(() => vi.restoreAllMocks());
  it('opens wide charts at the latest checks, keeps the price axis visible and preserves a manually selected position', () => {
    let width = 5000;
    vi.spyOn(HTMLElement.prototype,'scrollWidth','get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(800);
    const points:PricePoint[] = Array.from({length:245},(_,i) => ({checked_at:new Date(1760000000000+i*60000).toISOString(),price:10000+i}));
    const {container,rerender} = render(<PriceChart.Root points={points} total><Plot/></PriceChart.Root>);
    const scroll = screen.getByRole('region',{name:'Прокрутка истории цен'});
    expect(scroll.scrollLeft).toBe(4200);
    expect(container.querySelector('.price-chart-content')).toHaveStyle({minWidth:'4912px'});
    expect(container.querySelector('.chart-fixed-axis')).not.toBeNull();
    expect(container.querySelector('.chart-fixed-axis .recharts-yAxis')).not.toBeNull();
    scroll.scrollLeft = 1000;fireEvent.scroll(scroll);
    width = 5020;
    rerender(<PriceChart.Root points={[...points,{checked_at:new Date(1760000000000+245*60000).toISOString(),price:11000}]} total><Plot/></PriceChart.Root>);
    expect(scroll.scrollLeft).toBe(1000);
    scroll.scrollLeft = 4220;fireEvent.scroll(scroll);width = 5040;
    rerender(<PriceChart.Root points={[...points,...points.slice(-2)]} total><Plot/></PriceChart.Root>);
    expect(scroll.scrollLeft).toBe(4240);
  });
  it.each(['time', 'checks'] as const)('preserves paths and singleton dots on the %s scale', scale => {
    usePreferences.setState({chartScale: scale});
    const points = ['a', 'a', 'b', 'c', 'c'].map((composition, i) => ({composition, price: 10000 + i * 100, checked_at: '2026-10-11T00:00:00Z'}));
    const {container} = render(<PriceChart.Root points={points} total><Plot /></PriceChart.Root>);
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(4);
    expect(container.querySelectorAll('.recharts-line-dot')).toHaveLength(5);
    const paths = [...container.querySelectorAll('.recharts-line-curve')].map(path => path.getAttribute('d') || '');
    expect(paths.some(path => (path.match(/M/g) || []).length === 2)).toBe(true);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'История цены');
  });

  it('renders red and blue baselines, price markers and the error tooltip', async () => {
    usePreferences.setState({chartScale: 'checks'});
    const points: PricePoint[] = [
      {price: null, status: 'error' as const, message: 'Read failed'},
      {price: null, in_stock: false}, {price: 10000},
      {price: null, status: 'error' as const}, {price: null, in_stock: false},
    ].map((point, i) => ({...point, checked_at: new Date(1760000000000 + i * 1000).toISOString()}));
    const {container} = render(<PriceChart.Root points={points}><Plot /></PriceChart.Root>);
    expect(container.querySelectorAll('.chart-error-dot')).toHaveLength(2);
    expect(container.querySelectorAll('.chart-unavailable-dot')).toHaveLength(2);
    const chart = screen.getByRole('application');
    fireEvent.focus(chart);
    await waitFor(() => expect(screen.getByText('Read failed')).toBeInTheDocument());
    fireEvent.keyDown(chart, {key: 'ArrowRight'});
    await waitFor(() => expect(screen.getByText('Цена неизвестна')).toBeInTheDocument());
  });

  it('keeps a constant number of Lines for fragmented mini charts', () => {
    const points = Array.from({length: 24}, (_, i) => ({price: i * 100, composition: String(i), checked_at: '2026-10-11T00:00:00Z'}));
    const {container} = render(<PriceChart.Root points={points} total><Plot small /></PriceChart.Root>);
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(4);
    expect(container.querySelectorAll('.recharts-line-dot')).toHaveLength(24);
    expect(screen.queryByRole('application')).toBeNull();
  });

  it('handles empty history, a single price and errors before any known price', () => {
    const {container, rerender} = render(<PriceChart.Root points={[]}><Plot /></PriceChart.Root>);
    expect(screen.getByText('Пока нет данных для этого графика')).toBeInTheDocument();
    rerender(<PriceChart.Root points={[{checked_at: '2026-10-11T00:00:00Z', price: 10000}]}><Plot /></PriceChart.Root>);
    expect(container.querySelectorAll('.recharts-line-dot')).toHaveLength(1);
    rerender(<PriceChart.Root points={[{checked_at: '2026-10-11T00:00:00Z', price: null, status: 'error'}]}><Plot /></PriceChart.Root>);
    expect(container.querySelectorAll('.chart-error-dot')).toHaveLength(1);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});
