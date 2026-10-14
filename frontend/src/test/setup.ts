import '@testing-library/jest-dom/vitest';
import {afterEach} from 'vitest';
import {cleanup} from '@testing-library/react';

afterEach(cleanup);
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock;
Object.defineProperty(window, 'matchMedia', {value: () => ({matches: false, addEventListener() {}, removeEventListener() {}})});
