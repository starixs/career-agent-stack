import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryItem } from './types';

const api = vi.hoisted(() => ({
  memories: vi.fn(), addMemory: vi.fn(), updateMemory: vi.fn(), forgetMemory: vi.fn(),
}));
vi.mock('./careerApi', () => ({ careerApi: api }));

import { CareerMemoryList, groupMemories, scopeLabel } from './CareerMemoryList';

const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'mem_1', kind: 'collaboration', scope: 'user', content: '用户希望先说结论', importance: 3, evidence_count: 1, pinned: 0,
  status: 'active', source: 'extracted', last_used_at: null, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', ...over,
});

describe('groupMemories / scopeLabel', () => {
  it('通用在前，公司按名字；scope 显示成人话', () => {
    const groups = groupMemories([item({ id: 'a', scope: 'company:美团' }), item({ id: 'b' }), item({ id: 'c', scope: 'company:字节跳动' })]);
    expect(groups.map(g => g.label)).toEqual(['通用', ...['美团', '字节跳动'].sort((x, y) => x.localeCompare(y, 'zh'))]);
    expect(scopeLabel('application:app_1')).toContain('app_1');
  });
});

describe('CareerMemoryList', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset();
    api.memories.mockResolvedValue([
      item({ id: 'mem_1', content: '用户希望先说结论', source: 'explicit', evidence_count: 2 }),
      item({ id: 'mem_2', kind: 'fact', scope: 'company:美团', content: '美团网申要扫码登录' }),
    ]);
    api.updateMemory.mockResolvedValue(item({}));
    api.forgetMemory.mockResolvedValue({ ok: true });
    api.addMemory.mockResolvedValue(item({ id: 'mem_3' }));
  });

  it('按 scope 分组展示，带来源与次数；搜索在本地过滤', async () => {
    render(<CareerMemoryList />);
    await screen.findByText('用户希望先说结论');
    expect(screen.getByText('美团')).toBeInTheDocument();
    expect(screen.getByText(/你让它记的 · 提到过 2 次/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: '扫码' } });
    expect(screen.queryByText('用户希望先说结论')).not.toBeInTheDocument();
    expect(screen.getByText('美团网申要扫码登录')).toBeInTheDocument();
  });

  it('置顶 / 编辑保存 / 忘掉 都调对应接口并刷新', async () => {
    render(<CareerMemoryList />);
    const row = (await screen.findByText('用户希望先说结论')).closest('[data-testid="memory-row"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '置顶' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('mem_1', { pinned: true }));
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }));
    fireEvent.change(within(row).getByLabelText('记忆内容'), { target: { value: '用户希望先说结论，三句话以内' } });
    fireEvent.click(within(row).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('mem_1', { content: '用户希望先说结论，三句话以内', kind: 'collaboration' }));
    const row2 = (await screen.findByText('美团网申要扫码登录')).closest('[data-testid="memory-row"]') as HTMLElement;
    fireEvent.click(within(row2).getByRole('button', { name: '忘掉' }));
    await waitFor(() => expect(api.forgetMemory).toHaveBeenCalledWith('mem_2'));
    expect(api.memories.mock.calls.length).toBeGreaterThan(1);
  });

  it('手动添加：填了公司名就记到那家公司；接口报错时显示原因', async () => {
    render(<CareerMemoryList />);
    await screen.findByText('用户希望先说结论');
    fireEvent.click(screen.getByRole('button', { name: '添加一条' }));
    fireEvent.change(screen.getByLabelText('新记忆内容'), { target: { value: '面试官很看重算法' } });
    fireEvent.change(screen.getByLabelText('相关公司'), { target: { value: '美团' } });
    fireEvent.click(screen.getByRole('button', { name: '记住' }));
    await waitFor(() => expect(api.addMemory).toHaveBeenCalledWith({ content: '面试官很看重算法', kind: 'collaboration', scope: 'company:美团' }));

    api.addMemory.mockRejectedValueOnce(new Error('含私密信息（姓名 / 手机 / 邮箱等）'));
    fireEvent.click(screen.getByRole('button', { name: '添加一条' }));
    fireEvent.change(screen.getByLabelText('新记忆内容'), { target: { value: '手机 138' } });
    fireEvent.click(screen.getByRole('button', { name: '记住' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('含私密信息');
  });

  it('没有记忆时给出怎么让它记的提示', async () => {
    api.memories.mockResolvedValue([]);
    render(<CareerMemoryList />);
    expect(await screen.findByText('助理还没记下什么')).toBeInTheDocument();
  });
});
