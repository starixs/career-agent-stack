import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerResearch', () => ({ default: () => <div data-testid="embedded-research" /> }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent } from '@/api/eventBus';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerReview from './CareerReview';

const funnel = { overall: null, by_category: [], by_platform: [] };
const days = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, sent: 0, split: [0, 0, 0, 0], pending: false, companies: { exam: [] as string[], interview: [] as string[], offer: [] as string[] } }));
days[2] = { day: 3, sent: 6, split: [3, 1, 1, 1], pending: false, companies: { exam: ['字节'], interview: ['网易'], offer: ['阿里'] } };
days[24] = { day: 25, sent: 4, split: [4, 0, 0, 0], pending: true, companies: { exam: [], interview: [], offer: [] } };
const board = {
  month: { key: '2026-10', year: 2026, month: 10, days: 31, dow1: 4, today: 28, is_current: true, prev_key: '2026-09', next_key: null },
  counts: [156, 31, 11, 2], prev: [48, 14, 4, 0],
  history: [{ key: '2026-09', month: 9, counts: [48, 14, 4, 0] }],
  in_transit: 38, since_total: 204, days,
  exams: [{ company: '米哈游', kind: 'written_test', status: 'open', due_at: '2026-10-30T06:00:00Z' }, { company: '美团', kind: 'assessment', status: 'missed', due_at: '2026-10-21T15:00:00Z' }],
  interviews: [{ company: '腾讯', rounds: [{ round: '一面', done: true, date: '2026-10-22T06:00:00Z' }, { round: '二面', done: false, date: '2026-10-30T02:00:00Z' }] }],
  next_interview: { company: '快手', round: '二面', date: '2099-10-29T07:00:00Z' },
  offers: [{ company: '阿里', title: '后端开发', location: '杭州', reply_by: '2099-11-05T09:00:00Z' }],
  rhythm: { reply_days: 5, first_interview_after: 23 },
};
const emptyBoard = { ...board, month: { ...board.month, prev_key: null }, counts: [0, 0, 0, 0], prev: null, since_total: 0, days: days.map((d) => ({ ...d, sent: 0, split: [0, 0, 0, 0] })) };

function mockGet(opts: { empty?: boolean } = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/review')) {
      return { ok: true, funnel, board: opts.empty ? emptyBoard : board, reviews: [] };
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

  it('还没投出时不出空状态页：照样摆漏斗（标准初始形状），数字写真实的 0，不画过往月份', async () => {
    mockGet({ empty: true });
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const section = await screen.findByLabelText('本月漏斗');
    expect(screen.getByRole('button', { name: '投出 0' })).toBeInTheDocument();
    expect(within(section).queryByText('9 月')).not.toBeInTheDocument();
    expect(section.querySelectorAll('path[clip-path]')).toHaveLength(4);
    expect(within(screen.getByLabelText('本月关键数字')).getByLabelText('投出 0')).toBeInTheDocument();
    // 还没替他投出过：不摆「替你投出 0」
    expect(screen.queryByText(/替你投出/)).not.toBeInTheDocument();
  });

  it('顶部五个大数：本月四层带上月，另有用我们以来替你投出', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const stats = await screen.findByLabelText('本月关键数字');
    expect(within(stats).getByLabelText('投出 156')).toBeInTheDocument();
    expect(within(stats).getByLabelText('Offer 2')).toBeInTheDocument();
    expect(stats).toHaveTextContent('上月 48');
    expect(within(stats).getByLabelText('用我们以来 · 替你投出 204')).toBeInTheDocument();
    expect(screen.getByText('2026 年 10 月')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下个月' })).toBeDisabled();
  });

  it('面板平时留白；悬停某一层才出现，离开就收起；点击钉住', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const section = await screen.findByLabelText('本月漏斗');
    expect(within(section).queryByText('家请你面试')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '面试 11，上月 4' }));
    expect(within(section).getByText('家请你面试')).toBeInTheDocument();
    expect(section).toHaveTextContent('快手 · 二面');
    expect(section).toHaveTextContent('你第一次进面试，是在第 23 份之后');
    fireEvent.mouseLeave(section);
    expect(within(section).queryByText('家请你面试')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '投出 156，上月 48' }));
    fireEvent.mouseLeave(section);
    expect(section).toHaveTextContent('还有 38 份在路上');
    expect(section).toHaveTextContent('你的回音多半在投出后 5 天内到');
  });

  it('笔试层列出做完 / 错过 / 待做；转化率变好才写一句', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    fireEvent.mouseEnter(await screen.findByRole('button', { name: '面试 11，上月 4' }));
    // 31→11 = 35%，上月 14→4 = 29%：变好了
    expect(screen.getByText('从上一层走到这里 35% · 上月 29%')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '笔试/测评 31，上月 14' }));
    const section = screen.getByLabelText('本月漏斗');
    expect(section).toHaveTextContent('米哈游');
    expect(section).toHaveTextContent('错过');
    // 156→31 = 20%，上月 48→14 = 29%：变差不写
    expect(within(section).queryByText(/从上一层走到这里/)).not.toBeInTheDocument();
  });

  it('每一天：悬停浮出那天的投递后来怎么样了；还没结果的写还在等', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    const day3 = await screen.findByRole('button', { name: /^10\/3 周六，投出 6 份/ });
    fireEvent.mouseEnter(day3);
    expect(day3).toHaveTextContent('拿到 Offer · 阿里');
    expect(day3).toHaveTextContent('1 份进了面试 · 网易');
    expect(screen.getByRole('button', { name: /^10\/25 周日，投出 4 份，4 份投出不满 7 天，还在等/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10/30 周五，还没到' })).toBeInTheDocument();
  });

  it('切到上个月带 month 参数重新取数', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '上个月' }));
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledWith('/api/career/review?month=2026-09'));
  });

  it('不再有周复盘区块；焦点事件切回我的求职月；切到调研视图渲染嵌入页', async () => {
    mockGet();
    render(<CareerReview isActive onOpenChat={vi.fn()} />);
    await screen.findByLabelText('本月漏斗');
    expect(screen.queryByRole('button', { name: '生成本周复盘' })).not.toBeInTheDocument();
    act(() => { setCareerSubView('career-review', 'research'); });
    expect(await screen.findByTestId('embedded-research')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '公司调研' })).toBeInTheDocument();
    act(() => { emitEvent('career:focus', { surface: 'review' }); });
    expect(await screen.findByRole('heading', { name: '我的求职月' })).toBeInTheDocument();
  });
});
