import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent } from '@/api/eventBus';
import CareerExperience, { sortExperiences } from './CareerExperience';
import type { ExperienceNode } from '@/components/career/types';

const exp = (over: Partial<ExperienceNode>): ExperienceNode => ({
  id: 'e1', title: '后端实习', role: '实习生', org: '甲公司', start_date: '2024-06-01', end_date: '2024-09-01', type: 'intern',
  summary: null, redacted: 0, created_at: '2024-06-01', updated_at: '2024-06-01', claims: [], ...over,
});

const tree: ExperienceNode[] = [
  exp({
    id: 'e1', claims: [{
      id: 'c1', experience_id: 'e1', text: '把接口 P99 从 800ms 降到 200ms', attribution: 'self', result_metric: 'P99 -75%',
      status: 'pending', created_from: 'interview', created_at: '2024-06-01', updated_at: '2024-06-01',
      evidence: [{ id: 'ev1', claim_id: 'c1', kind: 'commit', locator: 'src/api.ts@abc123', excerpt: null, strength: 'strong', captured_at: '2024-06-01' }],
    }],
  }),
  exp({ id: 'e2', title: '毕业设计', org: '乙大学', start_date: '2023-01-01', end_date: '2023-06-01' }),
];

describe('CareerExperience', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('空状态给出对话引导', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, experiences: [] });
    render(<CareerExperience />);
    expect(await screen.findByText('还没有经历')).toBeInTheDocument();
    expect(screen.getByText('在对话里说「帮我整理经历」')).toBeInTheDocument();
  });

  it('按时间倒序渲染经历，并显示待核实数量与证据强度', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, experiences: tree });
    render(<CareerExperience />);
    expect(await screen.findByText('1 条主张待你核实')).toBeInTheDocument();
    const items = screen.getAllByRole('button', { name: /后端实习|毕业设计/ });
    expect(items[0]).toHaveTextContent('后端实习');
    expect(items[1]).toHaveTextContent('毕业设计');
    expect(screen.getByText('把接口 P99 从 800ms 降到 200ms')).toBeInTheDocument();
    expect(screen.getByText('本人')).toBeInTheDocument();
    expect(screen.getByText('P99 -75%')).toBeInTheDocument();
    expect(screen.getByText('强')).toBeInTheDocument();
  });

  it('点击「确认」调用 claims/:id/confirm 并刷新', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, experiences: tree });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerExperience />);
    fireEvent.click(await screen.findByRole('button', { name: '确认' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/claims/c1/confirm', {}));
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledTimes(2));
  });

  it('收到 career:data-changed 后自动刷新', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, experiences: tree });
    render(<CareerExperience />);
    await screen.findByText('1 条主张待你核实');
    emitEvent('career:data-changed', { sessionId: 's1', tables: ['claim'] });
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledTimes(2));
  });

  it('sortExperiences：进行中在前，然后按结束时间倒序', () => {
    const sorted = sortExperiences([
      exp({ id: 'a', end_date: '2022-01-01' }), exp({ id: 'b', end_date: null, start_date: '2024-01-01' }), exp({ id: 'c', end_date: '2023-01-01' }),
    ]);
    expect(sorted.map(e => e.id)).toEqual(['b', 'c', 'a']);
  });
});
