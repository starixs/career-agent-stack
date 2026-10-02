import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerResearch', () => ({ default: () => <div data-testid="embedded-research" /> }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerReview from './CareerReview';

const funnel = {
  overall: { key: 'overall', total: 12, applied: 10, responded: 3, interview: 2, offer: 1, rejected: 2, silent: 5 },
  by_category: [
    { key: '后端', total: 6, applied: 5, responded: 2, interview: 2, offer: 1, rejected: 1, silent: 2 },
    { key: '算法', total: 4, applied: 4, responded: 1, interview: 0, offer: 0, rejected: 1, silent: 3 },
    { key: '数据', total: 2, applied: 1, responded: 0, interview: 0, offer: 0, rejected: 0, silent: 0 },
  ],
  by_platform: [
    { key: 'boss', total: 8, applied: 7, responded: 3, interview: 2, offer: 1, rejected: 1, silent: 3 },
    { key: 'liepin', total: 4, applied: 3, responded: 0, interview: 0, offer: 0, rejected: 1, silent: 2 },
  ],
};
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
      return { ok: true, funnel: opts.empty ? { overall: null, by_category: [], by_platform: [] } : funnel, reviews: opts.noReviews || opts.empty ? [] : reviews };
    }
    return { ok: true };
  });
}

describe('CareerReview', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('没有投递数据时显示空态与让助理建议的按钮', async () => {
    mockGet({ empty: true });
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('还没有投递数据。先在收件箱丢几个 JD，投出去之后这里会出现漏斗。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '帮我看看接下来该投什么' })).toBeInTheDocument();
    expect(screen.queryByText('过简历率')).not.toBeInTheDocument();
  });

  it('总体数字、转化率、基准线说明与分组表', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByLabelText('总计 12')).toBeInTheDocument();
    expect(screen.getByLabelText('沉默 5')).toBeInTheDocument();
    const rates = screen.getByLabelText('转化率');
    expect(rates).toHaveTextContent('过简历率 30%');
    expect(rates).toHaveTextContent('面试推进率 67%');
    expect(rates).toHaveTextContent('Offer 率 50%');
    expect(screen.getByText('经验上网申过简历率通常只有一到两成，沉默比被拒常见；这不是能力结论。')).toBeInTheDocument();
    const byCategory = screen.getByRole('table', { name: '按岗位类别' });
    expect(byCategory).toHaveTextContent('后端');
    expect(byCategory).toHaveTextContent('走得最远');
    expect(byCategory).toHaveTextContent('挂得最多');
    const byPlatform = screen.getByRole('table', { name: '按平台' });
    expect(byPlatform).toHaveTextContent('boss');
    expect(byPlatform.querySelectorAll('[role="row"]')).toHaveLength(3);
  });

  it('分母为 0 时转化率显示 —', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, funnel: { overall: { key: 'overall', total: 3, applied: 0, responded: 0, interview: 0, offer: 0, rejected: 0, silent: 0 }, by_category: [], by_platform: [] }, reviews: [] });
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByLabelText('转化率')).toHaveTextContent('过简历率 —');
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
    fireEvent.click(screen.getByRole('tab', { name: '调研与方向' }));
    expect(await screen.findByTestId('embedded-research')).toBeInTheDocument();
  });
});
