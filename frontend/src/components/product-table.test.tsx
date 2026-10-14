import {useState, type ReactNode} from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it, vi} from 'vitest';
import {ProductTable, PriceChange, selectProducts} from './product-table';
import type {Filter, ProductRow} from '@/lib/types';

// These tests exercise table interactions; real SVG rendering is covered by Playwright.
vi.mock('./price-chart', () => ({PriceChart: {Root: ({children}: {children: ReactNode}) => children, Plot: () => null}}));

const nowMs = Date.parse('2026-10-14T12:00:00Z');
const product: ProductRow = {id: 1, sku: '123', brand: 'Brand', name: 'Fragrance', label: 'EDP 1.5 ml', url: 'https://randewoo.ru/product/test', image: '', quantity: 1, status: 'ok', price: 10000, previous_price: 15000, delta: 0, last_change: {checked_at: '2026-10-12T12:00:00Z', previous_price: 15000, price: 10000, delta: -5000}, minimum: 10000, observations: 2, in_stock: true, checked_at: null, price_at: null, message: '', watching: false, sparkline: []};
it('preserves historical drops after a failed check while excluding stale minimum-price matches', () => {
  const stale = {...product, id: 2, status: 'error' as const};
  expect(selectProducts([product, stale], '', 'minimum', 'name', 7, nowMs).map(item => item.id)).toEqual([1]);
  expect(selectProducts([product, stale], '', 'drops', 'name', 7, nowMs).map(item => item.id)).toEqual([1, 2]);
  render(<PriceChange item={stale} nowMs={nowMs} />);
  expect(screen.getByText('Нет свежих данных')).toBeInTheDocument();
  expect(screen.getByText('150 ₽ → 100 ₽')).toBeInTheDocument();
  expect(screen.getByText('Обнаружено 2 дня назад')).toBeInTheDocument();
  expect(screen.queryByText('Первая проверка')).not.toBeInTheDocument();
});
it('shares filter state across compound parts and opens the selected product with the keyboard', async () => {
  const selected = vi.fn(), user = userEvent.setup();
  function Harness() {
    const [filter, setFilter] = useState<Filter>('all');
    return <ProductTable.Root items={[product, {...product, id: 2, name: 'Other', status: 'error'}]} nowMs={nowMs} search="" sort="name" filter={filter} onChange={values => {if (values.filter) setFilter(values.filter);}} onSelect={selected}><ProductTable.Toolbar /><ProductTable.Rows /><ProductTable.Summary /></ProductTable.Root>;
  }
  render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
  expect(screen.getByText('Показано 2 из 2 товаров')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Фильтр товаров'), 'minimum');
  expect(screen.getByText('Показано 1 из 2 товаров')).toBeInTheDocument();
  screen.getByLabelText('История: Brand Fragrance').focus(); await user.keyboard('{Enter}');
  expect(selected).toHaveBeenCalledWith(1);
});
it('filters by detection time and the last direction instead of the latest check delta', () => {
  const older = {...product, id: 2, last_change: {...product.last_change!, checked_at: '2026-10-04T12:00:00Z'}};
  const rise = {...product, id: 3, price: 95000, delta: 0, last_change: {checked_at: '2026-10-13T12:00:00Z', previous_price: 80000, price: 95000, delta: 15000}};
  const never = {...product, id: 4, last_change: null};
  const items = [older, product, never, rise];
  expect(selectProducts(items, '', 'changed', 'recent', 7, nowMs).map(item => item.id)).toEqual([3, 1]);
  expect(selectProducts(items, '', 'changed', 'recent', 14, nowMs).map(item => item.id)).toEqual([3, 1, 2]);
  expect(selectProducts(items, '', 'rises', 'recent', 7, nowMs).map(item => item.id)).toEqual([3]);
  expect(selectProducts(items, '', 'drops', 'recent', 7, nowMs).map(item => item.id)).toEqual([1]);
});
it('renders product names as text rather than executable markup', () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProductTable.Root items={[{...product, name: '<img src=x onerror=alert(1)>'}]} search="" filter="all" sort="name" onChange={() => {}} onSelect={() => {}}><ProductTable.Rows /></ProductTable.Root></QueryClientProvider>);
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
});
