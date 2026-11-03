import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { PickTable, allPicked, pickedIds, type PickGroup } from './PickTable';

const GROUPS: PickGroup[] = [
  { id: 'g1', title: '美团', rows: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }] },
  { id: 'g2', title: '项目', rows: [{ id: 'd', text: 'D' }, { id: 'e', text: 'E' }] },
];

function Harness() {
  const [picked, setPicked] = useState(() => allPicked(GROUPS));
  return <><PickTable groups={GROUPS} picked={picked} onChange={setPicked} actions={null} /><output>{pickedIds(picked).join(',')}</output></>;
}
const state = () => screen.getByRole('status').textContent;
const row = (name: string) => screen.getByRole('checkbox', { name });

describe('整批勾选表：不用一条一条点', () => {
  it('按住拖过几行，一起取消；松开后再经过不再改', () => {
    render(<Harness />);
    fireEvent.pointerDown(row('A'));
    fireEvent.pointerEnter(row('B'));
    fireEvent.pointerEnter(row('D'));
    fireEvent.pointerUp(window);
    fireEvent.pointerEnter(row('E'));
    expect(state()).toBe('c,e');
  });

  it('Shift 点连选：从上次点的那行连到这行', () => {
    render(<Harness />);
    fireEvent.pointerDown(row('A'));
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(row('D'), { shiftKey: true });
    expect(state()).toBe('e');
  });

  it('整组勾 / 全选', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('整组：美团'));
    expect(state()).toBe('d,e');
    fireEvent.click(screen.getByLabelText('全选'));
    expect(state()).toBe('a,b,c,d,e');
  });
});
