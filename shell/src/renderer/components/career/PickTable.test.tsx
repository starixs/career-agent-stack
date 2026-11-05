import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PickTable, allPicked, pickedIds, type PickGroup } from './PickTable';

const GROUPS: PickGroup[] = [
  { id: 'g1', title: '美团', rows: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }] },
  { id: 'g2', title: '项目', rows: [{ id: 'd', text: 'D' }, { id: 'e', text: 'E' }] },
];

function Harness({ groups = GROUPS, onPrimary }: { groups?: PickGroup[]; onPrimary?: () => void }) {
  const [picked, setPicked] = useState(() => allPicked(groups));
  return <><PickTable groups={groups} picked={picked} onChange={setPicked} actions={null} onPrimary={onPrimary} filterPlaceholder="筛公司 / 城市" /><output>{pickedIds(picked).join(',')}</output></>;
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

  it('组可折叠；键盘上下、空格、⌘A', () => {
    const onPrimary = vi.fn();
    render(<Harness onPrimary={onPrimary} />);
    fireEvent.click(screen.getByRole('button', { name: '收起：项目' }));
    expect(screen.queryByTestId('pick-row-d')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开：项目' }));
    expect(screen.getByTestId('pick-row-d')).toBeInTheDocument();
    row('A').focus();
    fireEvent.keyDown(row('A'), { key: ' ' });
    expect(state()).toBe('b,c,d,e');
    fireEvent.keyDown(row('A'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('B'));
    fireEvent.keyDown(row('B'), { key: 'ArrowDown', shiftKey: true });
    expect(state()).toBe('b,c,d,e');
    fireEvent.keyDown(row('C'), { key: ' ' });
    fireEvent.keyDown(row('C'), { key: 'ArrowDown', shiftKey: true });
    expect(state()).toBe('b,e');
    fireEvent.keyDown(row('D'), { key: 'a', metaKey: true });
    expect(state()).toBe('a,b,c,d,e');
    fireEvent.keyDown(row('D'), { key: 'Enter' });
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('筛选只筛看得见的行，不改勾选', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('筛公司 / 城市'), { target: { value: 'd' } });
    expect(screen.queryByTestId('pick-row-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('pick-row-d')).toBeInTheDocument();
    expect(state()).toBe('a,b,c,d,e');
  });
});
