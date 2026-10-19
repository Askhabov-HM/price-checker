import type {PricePoint} from './types';

export function isUnavailable(point: Pick<PricePoint, 'status' | 'in_stock'>) {
  return point.status !== 'error' && (point.status === 'missing' || point.in_stock === false || point.in_stock === 0);
}
