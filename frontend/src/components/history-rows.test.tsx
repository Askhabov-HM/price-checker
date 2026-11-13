import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {HistoryRows} from './history-rows';

it('renders bounded pages newest first without losing or duplicating observations',() => {
  const points=Array.from({length:205},(_,index)=>index);
  const {container,rerender}=render(<table><HistoryRows points={points} columns={1}>{point=><tr key={point}><td data-point={point}>{point}</td></tr>}</HistoryRows></table>);
  const read=()=>Array.from(container.querySelectorAll('[data-point]'),node=>Number(node.getAttribute('data-point')));
  const visited=[...read()];expect(visited).toHaveLength(100);expect(visited[0]).toBe(204);
  fireEvent.click(screen.getByText('Старее'));visited.push(...read());
  fireEvent.click(screen.getByText('Старее'));visited.push(...read());
  expect(visited).toEqual(points.toReversed());expect(screen.getByText('Старее')).toBeDisabled();
  fireEvent.click(screen.getByText('Новее'));expect(read()[0]).toBe(104);
  rerender(<table><HistoryRows key="other-product" points={[999]} columns={1}>{point=><tr key={point}><td data-point={point}>{point}</td></tr>}</HistoryRows></table>);
  expect(read()).toEqual([999]);expect(screen.queryByText('Старее')).toBeNull();
});
