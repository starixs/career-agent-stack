/**
 * 批量勾选卡（face-beta-polish）：表头说方向和简历，每行说这家会怎样；默认勾选由服务端定，
 * 没勾的行变淡不划掉；点「投这 N 家」只投勾上的，并带上卡片 id 让服务端把卡收成"已开始投 N 家"。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./CareerPrimitives', async (orig) => ({ ...(await orig<typeof import('./CareerPrimitives')>()), suggestToChat: vi.fn() }));

import { apiPostJson } from '@/api/apiFetch';

import { suggestToChat } from './CareerPrimitives';
import { NO_RESUME_OPENER } from './ColdStartCards';

import { BatchPickCard, rowNote } from './BatchPickCard';
import type { CareerCard } from './types';

const row = (job_id: string, company: string, over: Record<string, unknown> = {}) => ({
  job_id, company, title: '管培生', city: '上海', system: '北森', known: true, target: false, picked: true, ...over,
});

const card = (data: Record<string, unknown>): CareerCard => ({
  id: 'batch-pick:1', kind: 'batch_pick', title: '先投这 2 家？', data, createdAt: '2026-11-05T00:00:00Z', sessionId: 's1', toolUseId: null, state: 'pending',
});

describe('BatchPickCard', () => {
  beforeEach(() => { vi.mocked(apiPostJson).mockReset(); });

  it('行尾小签：投过的系统写我会了，没投过的先停给你看，标星先给你看', () => {
    expect(rowNote(row('a', 'A'))).toBe('上海 · 北森 · 我会了');
    expect(rowNote(row('b', 'B', { known: false, system: null, city: null }))).toBe('先停给你看');
    expect(rowNote(row('c', 'C', { target: true }))).toBe('上海 · ★ 先给你看');
  });

  it('只投勾上的，带上卡片 id 和简历', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, started: ['x'], skipped: [] });
    const onDone = vi.fn();
    render(<BatchPickCard
      card={card({ rows: [row('j1', '招商银行'), row('j2', '平安'), row('j3', '美的', { picked: false })], more: 4, direction: ['财务'], resume: { id: 'r1', name: '财务版' } })}
      onDone={onDone} onDismiss={() => {}}
    />);
    expect(screen.getByText('按你的方向：财务')).toBeInTheDocument();
    expect(screen.getByText(/用「财务版」 · 还有 4 家能投/)).toBeInTheDocument();
    const third = screen.getByTestId('pick-row-j3');
    expect(third.className).not.toContain('line-through');
    fireEvent.click(screen.getByRole('button', { name: '投这 2 家' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/propose/start', { card_id: 'batch-pick:1', job_ids: ['j1', 'j2'], resume_id: 'r1' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('没有能投的岗位时说一句，不出空表', () => {
    render(<BatchPickCard card={card({ rows: [], more: 0, direction: [], resume: null })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('岗位库里暂时没有现在就能投的，有新的我再叫你。')).toBeInTheDocument();
  });

  it('还没有简历：给「先做一份简历」，发出和起步卡同一句', () => {
    const onDismiss = vi.fn();
    render(<BatchPickCard card={card({ rows: [], more: 0, direction: [], resume: null, blocked: 'no_resume' })} onDone={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '先做一份简历' }));
    expect(suggestToChat).toHaveBeenCalledWith(NO_RESUME_OPENER);
    expect(onDismiss).toHaveBeenCalled();
  });
});
