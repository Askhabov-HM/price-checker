import {useState, type ReactNode} from 'react';
import {Button} from './ui/button';

const pageSize = 100;
// Reverse only the visible page. Keep every observation available without
// mounting thousands of rows and date/price formatters when a dialog opens.
export function HistoryRows<T>({points, columns, children, id}: {
  points: T[]; columns: number; children: (point: T, index: number) => ReactNode; id?: string;
}) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(points.length / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const end = Math.max(0, points.length - current * pageSize), start = Math.max(0, end - pageSize);
  return <tbody id={id}>
    {points.slice(start, end).reverse().map((point, index) => children(point, end - index - 1))}
    {!points.length && <tr><td colSpan={columns} className="empty-state">В этом периоде ещё нет проверок.</td></tr>}
    {lastPage > 0 && <tr><td colSpan={columns}><div className="history-pagination" aria-label="Страницы истории">
      <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Новее</Button>
      <span>{current * pageSize + 1}–{points.length - start} из {points.length}</span>
      <Button variant="outline" size="sm" disabled={current === lastPage} onClick={() => setPage(current + 1)}>Старее</Button>
    </div></td></tr>}
  </tbody>;
}
