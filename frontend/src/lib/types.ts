export type ListId = 'cart' | 'favorites' | 'watching';
export type PriceContext = 'public' | 'cart';
export type ChartScale = 'time' | 'checks';
export type Period = 0 | 7 | 30 | 90;
export type Filter = 'all' | 'drops' | 'rises' | 'minimum' | 'unavailable' | 'errors';
export type Sort = 'name' | 'price-asc' | 'price-desc' | 'delta';
export interface PricePoint {
  checked_at: string;
  price: number | null;
  status?: 'ok' | 'error' | 'missing' | 'pending';
  in_stock?: boolean | number | null;
  message?: string;
  composition?: string;
}
export interface HistoryPoint extends PricePoint {
  known_total: number;
  count: number;
  priced_count: number;
  complete: boolean;
}
export interface Product {
  id: number;
  sku: string | null;
  brand: string;
  name: string;
  label: string;
  url: string;
}
export interface ProductRow extends Product {
  image: string;
  quantity: number;
  status: 'ok' | 'error' | 'missing' | 'pending';
  price: number | null;
  previous_price: number | null;
  delta: number | null;
  minimum: number | null;
  observations: number;
  in_stock: boolean | null;
  checked_at: string | null;
  price_at: string | null;
  message: string;
  watching: boolean;
  sparkline: PricePoint[];
}
export interface Check {
  id: number;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total: number;
  completed: number;
  message: string;
}
export interface Status {
  running: boolean;
  checks: Check[];
  schedule: string[];
  schedule_enabled: boolean;
  next_check: string | null;
  auth_status: string;
  auth_message: string;
  csrf_token: string | null;
  test_mode?: boolean;
}
export interface DashboardData {
  items: ProductRow[];
  counts: Record<ListId, number>;
  history: HistoryPoint[];
  status: Status;
  list: ListId;
  context: PriceContext;
}
export interface DetailData {product: Product; context: PriceContext; points: PricePoint[];}
