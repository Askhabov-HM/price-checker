import {act, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {useNow} from './use-now';

afterEach(() => vi.useRealTimers());
it('uses fresh time when data rerenders and updates idle or returning tabs', () => {
  vi.useFakeTimers();
  const start = Date.parse('2026-10-14T12:00:00Z');
  vi.setSystemTime(start);
  function Clock({revision}: {revision: number}) {return <output data-revision={revision}>{useNow()}</output>;}
  const view = render(<Clock revision={0} />);
  expect(screen.getByRole('status')).toHaveTextContent(String(start));
  vi.setSystemTime(start + 5000);
  view.rerender(<Clock revision={1} />);
  expect(screen.getByRole('status')).toHaveTextContent(String(start + 5000));
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByRole('status')).toHaveTextContent(String(start + 65000));
  vi.setSystemTime(start + 120000);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.getByRole('status')).toHaveTextContent(String(start + 120000));
});
