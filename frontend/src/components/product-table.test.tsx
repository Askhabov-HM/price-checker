import {useState} from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it, vi} from 'vitest';
import {ProductTable, PriceChange, selectProducts} from './product-table';
import type {Filter, ProductRow} from '@/lib/types';

const product: ProductRow = {id: 1, sku: '123', brand: 'Brand', name: 'Fragrance', label: 'EDP 1.5 ml', url: 'https://randewoo.ru/product/test', image: '', quantity: 1, status: 'ok', price: 10000, previous_price: 15000, delta: -5000, minimum: 10000, observations: 2, in_stock: true, checked_at: null, price_at: null, message: '', watching: false, sparkline: []};
it('does not promote stale prices to drops or minimum-price matches', () => {
  const stale = {...product, id: 2, status: 'error' as const};
  expect(selectProducts([product, stale], '', 'minimum', 'name').map(item => item.id)).toEqual([1]);
  expect(selectProducts([product, stale], '', 'drops', 'name').map(item => item.id)).toEqual([1]);
  render(<PriceChange item={stale} />);
  expect(screen.getByText('Нет свежих данных')).toBeInTheDocument();
  expect(screen.queryByText('Первая проверка')).not.toBeInTheDocument();
});
it('shares filter state across compound parts and opens the selected product with the keyboard', async () => {
  const selected = vi.fn(), user = userEvent.setup();
  function Harness() {
    const [filter, setFilter] = useState<Filter>('all');
    return <ProductTable.Root items={[product, {...product, id: 2, name: 'Other', status: 'error'}]} search="" sort="name" filter={filter} onChange={values => {if (values.filter) setFilter(values.filter);}} onSelect={selected}><ProductTable.Toolbar /><ProductTable.Rows /><ProductTable.Summary /></ProductTable.Root>;
  }
  render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
  expect(screen.getByText('Показано 2 из 2 товаров')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Фильтр товаров'), 'minimum');
  expect(screen.getByText('Показано 1 из 2 товаров')).toBeInTheDocument();
  screen.getByLabelText('История: Brand Fragrance').focus(); await user.keyboard('{Enter}');
  expect(selected).toHaveBeenCalledWith(1);
});
it('renders product names as text rather than executable markup', () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProductTable.Root items={[{...product, name: '<img src=x onerror=alert(1)>'}]} search="" filter="all" sort="name" onChange={() => {}} onSelect={() => {}}><ProductTable.Rows /></ProductTable.Root></QueryClientProvider>);
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
});
