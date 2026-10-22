import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {CollectionNotice} from './collection-notice';

it('distinguishes a queued check from an active collection, including another process',() => {
  const {rerender} = render(<CollectionNotice status={{queued:true,queue_position:2,active_store:'ozon'}}/>);
  expect(screen.getByRole('status')).toHaveTextContent('позиция 2');
  expect(screen.getByRole('status')).toHaveTextContent('Сейчас проверяется Ozon');
  rerender(<CollectionNotice status={{queued:true,queue_position:1,active_store:null}}/>);
  expect(screen.getByRole('status')).toHaveTextContent('Ожидаем освобождения сборщика');
  rerender(<CollectionNotice status={{queued:false,active_store:'lamoda'}}/>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
