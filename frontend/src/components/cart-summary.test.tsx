import {useState} from 'react';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it} from 'vitest';
import {CartSummary} from './cart-summary';
import type {ProductRow} from '@/lib/types';

it('toggles 10% on available prices while excluding stale, missing, and sold-out products', async () => {
  const items = [
    {status: 'ok', in_stock: true, price: 678900},
    {status: 'error', in_stock: true, price: 10000},
    {status: 'missing', in_stock: false, price: null},
    {status: 'ok', in_stock: false, price: 20000},
  ] as ProductRow[];
  function Harness() {
    const [discountEnabled, setDiscountEnabled] = useState(false);
    return <CartSummary list="my-cart" items={items} discountEnabled={discountEnabled} onDiscountChange={setDiscountEnabled} />;
  }
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByText(/1 доступных из 4/)).toBeInTheDocument();
  expect(document.querySelector('#my-cart-subtotal')).toHaveTextContent('6 789 ₽');
  expect(document.querySelector('#my-cart-total')).toHaveTextContent('6 789 ₽');
  expect(screen.getByRole('checkbox', {name: 'Скидка 10%'})).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', {name: 'Скидка 10%'}));
  expect(document.querySelector('#my-cart-savings')).toHaveTextContent('678,9 ₽');
  expect(document.querySelector('#my-cart-total')).toHaveTextContent('6 110,1 ₽');
  await user.click(screen.getByRole('checkbox', {name: 'Скидка 10%'}));
  expect(document.querySelector('#my-cart-total')).toHaveTextContent('6 789 ₽');
  expect(document.querySelector('#my-cart-savings')).toHaveTextContent('0 ₽');
  expect(items[0].price).toBe(678900);
});

it('does not show a calculated zero before prices load', () => {
  render(<CartSummary list="cart" items={[]} discountEnabled={false} onDiscountChange={() => {}} loading />);
  expect(document.querySelector('#cart-total')).toHaveTextContent('—');
  expect(screen.getByRole('checkbox', {name: 'Скидка 10%'})).toBeDisabled();
});
