import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerResearch', () => ({ default: () => <div data-testid="embedded-research" /> }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerReview from './CareerReview';

const funnel = { overall: null, by_category: [], by_platform: [] };
const layer = (layer: string, n: number, extra: Record<string, unknown> = {}) => ({
  layer, n, rate: null, new_this_week: 0, stopped: { waiting: 0, silent: 0, rejected: 0, discarded: 0, hired: 0 },
  median_days_to_next: null, application_ids: [], silent_ids: [], summary: '', ...extra,
});
const board = {
  week: { start: '2026-10-19', days: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'], is_current: true, tz_offset_minutes: 480 },
  kpis: { applied: 3, applied_prev: 2, responded: 1, interviews: 1, due: 3, done: 2, missed: 1, response_rate: 0.5 },
  funnel: [
    layer('applied', 4, { new_this_week: 3, stopped: { waiting: 1, silent: 1, rejected: 0, discarded: 0, hired: 0 }, application_ids: ['a', 'b', 'c', 'd'], silent_ids: ['c'], summary: '累计投出 4 条。' }),
    layer('responded', 2, { rate: 0.5, new_this_week: 1, application_ids: ['a', 'b'], median_days_to_next: 4, summary: '已投递的 4 条里，2 条走到了有回应（50%）。' }),
    layer('interview', 2, { rate: 1, stopped: { waiting: 1, silent: 0, rejected: 1, discarded: 0, hired: 0 }, application_ids: ['a', 'b'] }),
    layer('offer', 0, { rate: 0 }),
  ],
  gantt: [
    { id: 'late', source: 'deadline', kind: 'written_test', title: '甲公司笔试', company_name: '甲公司', application_id: 'a', start: '2026-10-19T02:00:00Z', end: '2026-10-20T06:00:00Z', status: 'missed' },
    { id: 'i2', source: 'interview', kind: 'interview', title: '乙公司 二面', company_name: '乙公司', application_id: 'b', start: '2026-10-19T00:00:00Z', end: '2026-10-21T02:00:00Z', status: 'done' },
    { id: 'next', source: 'deadline', kind: 'assessment', title: '无主测评', company_name: null, application_id: null, start: '2026-10-21T00:00:00Z', end: '2026-10-29T06:00:00Z', status: 'open' },
  ],
  undated: [{ id: 'tbd', kind: 'assessment', title: '丙 测评', company_name: '丙公司', application_id: 'c' }],
  daily: [
    { date: '2026-10-19', n: 2, by_platform: [{ key: 'boss', n: 1 }, { key: 'campus', n: 1 }], application_ids: ['d', 'e'] },
    ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map((date, i) => ({ date, n: i === 1 ? 1 : 0, by_platform: i === 1 ? [{ key: 'boss', n: 1 }] : [], application_ids: i === 1 ? ['f'] : [] })),
  ],
};
const emptyBoard = { ...board, kpis: { ...board.kpis, applied: 0 }, funnel: board.funnel.map(l => ({ ...l, n: 0 })), gantt: [], undated: [], daily: board.daily.map(d => ({ ...d, n: 0 })) };
const reviews = [
  {
    id: 'r1', week_start: '2026-09-28', funnel_json: '{}', small_action: '给丙公司发一封一面后的跟进邮件',
    insights_json: JSON.stringify([{ finding: 'Boss 直聘的过简历率明显高于猎聘', strength: 'strong' }, '算法岗四投零面，可能是简历关键词问题']),
    suggestions_json: JSON.stringify([{ action: '把算法岗简历按 JD 关键词改一版', why: '四投零面', priority: 2 }, { action: '本周再投 5 个 Boss 上的后端岗', why: '回应率最高', priority: 1 }]),
    created_at: '2026-10-02',
  },
  { id: 'r0', week_start: '2026-09-21', funnel_json: '{}', small_action: null, insights_json: '[]', suggestions_json: '[]', created_at: '2026-09-25' },
];

function mockGet(opts: { empty?: boolean; noReviews?: boolean } = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/review')) {
      return { ok: true, funnel, board: opts.empty ? emptyBoard : board, reviews: opts.noReviews || opts.empty ? [] : reviews };
    }
    return { ok: true };
  });
}

describe('CareerReview', () => {
  beforeEach(() => {
    resetCareerSubViews();
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('没有投递数据时显示空态与让助理建议的按钮', async () => {
    mockGet({ empty: true });
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('还没有投递数据。先在收件箱丢几个 JD，投出去之后这里会出现漏斗。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '帮我看看接下来该投什么' })).toBeInTheDocument();
    expect(screen.queryByLabelText('累计漏斗')).not.toBeInTheDocument();
  });

  it('顶部关键数字：投出和上周比、到期事项完成与错过、累计回应率', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const stats = await screen.findByLabelText('关键数字');
    expect(within(stats).getByLabelText('投出 3')).toBeInTheDocument();
    expect(stats).toHaveTextContent('比上周多 1');
    expect(within(stats).getByLabelText('到期事项完成 2/3')).toBeInTheDocument();
    expect(stats).toHaveTextContent('错过 1 件');
    expect(within(stats).getByLabelText('累计回应率 50%')).toBeInTheDocument();
    expect(screen.getByText('10/19 – 10/25 · 本周')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一周' })).toBeDisabled();
  });

  it('漏斗：悬停弹出去向和总结，按钮带着这一层的投递跳到投递记录', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const applied = await screen.findByRole('button', { name: '已投递 4 条' });
    expect(screen.getByRole('button', { name: '有回应 2 条，上一层的 50%' })).toBeInTheDocument();
    fireEvent.mouseEnter(applied);
    const pop = screen.getByRole('dialog', { name: '已投递详情' });
    expect(pop).toHaveTextContent('累计投出 4 条。');
    expect(within(pop).getByLabelText('去向')).toHaveTextContent('走到下一层2还在等1沉默1');
    const seen: unknown[] = [];
    const off = onEvent('career:focus', p => { seen.push(p); });
    fireEvent.click(within(pop).getByRole('button', { name: '只看沉默的 1 条' }));
    expect(seen).toEqual([{ surface: 'dossier', origin: 'user', filter: { label: '漏斗 · 停在已投递且已沉默', application_ids: ['c'] } }]);
    off();
    fireEvent.mouseLeave(applied);
    expect(screen.queryByRole('dialog', { name: '已投递详情' })).not.toBeInTheDocument();
    // 点击钉住，Esc 收起
    fireEvent.click(screen.getByRole('button', { name: '有回应 2 条，上一层的 50%' }));
    fireEvent.mouseLeave(screen.getByRole('button', { name: '有回应 2 条，上一层的 50%' }));
    expect(screen.getByRole('dialog', { name: '有回应详情' })).toHaveTextContent('已钉住');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '有回应详情' })).not.toBeInTheDocument();
  });

  it('甘特：每件事带状态文字，点一行跳到对应投递；每日投出可点；时间待定的另列', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const late = await screen.findByRole('button', { name: '甲公司笔试，笔试，截止 10/20 周二 14:00，已错过' });
    expect(late).toHaveTextContent('已错过');
    expect(screen.getByRole('group', { name: '无主测评，测评，截止 10/29 周四 14:00，待完成' })).toHaveTextContent('→ 10/29');
    expect(screen.getByText('另有 1 件时间待定：丙公司 测评')).toBeInTheDocument();
    const seen: unknown[] = [];
    const off = onEvent('career:focus', p => { seen.push(p); });
    fireEvent.click(late);
    fireEvent.click(screen.getByRole('button', { name: '周一 投出 2 条：Boss 直聘 1、校招官网 1' }));
    expect(seen).toEqual([
      { surface: 'dossier', origin: 'user', application_id: 'a' },
      { surface: 'dossier', origin: 'user', filter: { label: '10/19 周一投出的', application_ids: ['d', 'e'] } },
    ]);
    off();
  });

  it('切到上一周带 week 参数重新取数', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '上一周' }));
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledWith('/api/career/review?week=2026-10-12'));
  });

  it('生成本周复盘调用 review/weekly，带上补充说明', async () => {
    mockGet({ noReviews: true });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, review: { id: 'r2' } });
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const button = await screen.findByRole('button', { name: '生成本周复盘' });
    fireEvent.click(button);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/review/weekly', {}));
    fireEvent.change(screen.getByLabelText('补充说明'), { target: { value: '这周状态很差，只投了两个' } });
    fireEvent.click(screen.getByRole('button', { name: '生成本周复盘' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/review/weekly', { user_note: '这周状态很差，只投了两个' }));
  });

  it('复盘卡片：小事 + 发进对话、发现与建议按优先级', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('给丙公司发一封一面后的跟进邮件')).toBeInTheDocument();
    expect(screen.getByText('今天就能做的一件小事')).toBeInTheDocument();
    expect(screen.getByText('Boss 直聘的过简历率明显高于猎聘')).toBeInTheDocument();
    expect(screen.getByText('强')).toBeInTheDocument();
    expect(screen.getByText('算法岗四投零面，可能是简历关键词问题')).toBeInTheDocument();
    const suggestions = screen.getAllByRole('listitem').map(li => li.textContent ?? '');
    const first = suggestions.findIndex(t => t.includes('本周再投 5 个 Boss 上的后端岗'));
    const second = suggestions.findIndex(t => t.includes('把算法岗简历按 JD 关键词改一版'));
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    // 最新的一周排在前面
    const cards = screen.getAllByText(/这周$/).map(el => el.textContent);
    expect(cards[0]).toBe('2026-09-28 这周');

    const seen: Array<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '帮我做这件事：给丙公司发一封一面后的跟进邮件' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toMatchObject({ surface: 'review', refs: { review_id: 'r1' } });
    off();
  });

  it('焦点事件滚到并高亮对应复盘；切到调研视图渲染嵌入页', async () => {
    mockGet();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    await screen.findByText('给丙公司发一封一面后的跟进邮件');
    act(() => { emitEvent('career:focus', { surface: 'review', id: 'r0' }); });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.getElementById('weekly-review-r0')?.querySelector('.ring-2')).not.toBeNull();
    act(() => { setCareerSubView('career-review', 'research'); });
    expect(await screen.findByTestId('embedded-research')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '公司调研与方向' })).toBeInTheDocument();
  });
});
