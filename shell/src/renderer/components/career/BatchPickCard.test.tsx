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

import { BatchPickCard, resumeChip, rowNote } from './BatchPickCard';
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
    expect(screen.getByText('用「财务版」')).toBeInTheDocument();
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

  it('简历签：定制版写改了几处，没拿到岗位描述如实说', () => {
    expect(resumeChip({ kind: 'tailored', resume_id: 't', name: '财务版', changes: 6 })).toBe('定制版 · 改 6 处');
    expect(resumeChip({ kind: 'will_tailor', resume_id: 'm', name: '财务版', changes: null })).toBe('投时按岗位定制');
    expect(resumeChip({ kind: 'no_jd', resume_id: 'm', name: '财务版', changes: null })).toBe('主简历（没拿到岗位描述）');
  });

  it('预设 全部/这周截止/前 20 只改勾选', () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const rows = Array.from({ length: 25 }, (_, i) => row(`j${i}`, `公司${i}`, { picked: i < 5, deadline: i < 3 ? soon : null }));
    rows.push(row('dup', '公司0', { picked: false }));
    render(<BatchPickCard card={card({ rows, direction: ['财务'], resume: { id: 'r1', name: '财务版' } })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: '投这 5 家' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全部 25 家（26 个岗）' }));
    expect(screen.getByRole('button', { name: '投这 25 家' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '这周截止 3' }));
    expect(screen.getByRole('button', { name: '投这 3 家' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前 20' }));
    expect(screen.getByRole('button', { name: '投这 20 家' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('一家只投一个岗'));
    fireEvent.click(screen.getByRole('button', { name: '全部 25 家（26 个岗）' }));
    expect(screen.getByRole('button', { name: '投这 26 家' })).toBeInTheDocument();
    expect(screen.getByText('公司0勾了 2 个岗')).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('表头写今天已投出 · 在填 · 备好；新网站攒一起登录；released 不说首批那句', () => {
    render(<BatchPickCard card={card({
      rows: [row('j1', 'A'), row('j2', 'B', { known: false })], direction: ['财务'], resume: null, stage: 'released',
      today: { sent: 12, filling: 4, prepared: 3 },
    })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: '今天已投出 12 · 在填 4 · 备好 3' })).toBeInTheDocument();
    expect(screen.getByText('1 家是新网站，要登录时我攒在一起叫你一次')).toBeInTheDocument();
    expect(screen.queryByText(/填到提交前停下/)).not.toBeInTheDocument();
  });

  it('常设授权：点「好」走信任账本盖章', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<BatchPickCard card={card({ rows: [row('j1', 'A')], propose_delegate: [{ key: 'system:beisen', label: '北森', successes: 2 }] })} onDone={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '好' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/trust', { key: 'system:beisen', action: 'delegate' }));
    expect(await screen.findByText('好，北森这类以后直接投')).toBeInTheDocument();
  });

  it('分组：上次没投的那组默认收起', () => {
    render(<BatchPickCard card={card({
      rows: [row('j1', 'A', { group: 'all' }), row('j2', 'B', { group: 'unpicked', picked: false })],
      groups: [{ id: 'all', title: '能投的', collapsed: false }, { id: 'unpicked', title: '上次没投的 1 家', collapsed: true }],
    })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('pick-row-j1')).toBeInTheDocument();
    expect(screen.queryByTestId('pick-row-j2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开：上次没投的 1 家' }));
    expect(screen.getByTestId('pick-row-j2')).toBeInTheDocument();
  });
  it('一家只投一个岗开着：整组、全选、⌘A 一次勾上同一家几个岗，只留靠前那行', () => {
    const rows = [row('a1', 'A', { picked: false }), row('a2', 'A', { picked: false }), row('b1', 'B', { picked: false })];
    render(<BatchPickCard card={card({ rows })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: '全部 2 家（3 个岗）' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('全选'));
    expect(screen.getByRole('button', { name: '投这 2 家' })).toBeInTheDocument();
    expect(screen.getByTestId('pick-row-a1')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('pick-row-a2')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByLabelText('全选'));
    fireEvent.keyDown(screen.getByTestId('pick-row-a1'), { key: 'a', metaKey: true });
    expect(screen.getByRole('button', { name: '投这 2 家' })).toBeInTheDocument();
  });

  it('换一批排完不剩：说刚才那张还在上面', () => {
    render(<BatchPickCard card={card({ rows: [], excluded: 3 })} onDone={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('刚才那张表还在上面，从那里挑就行。')).toBeInTheDocument();
  });
});
