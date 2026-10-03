import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerToday, { formatDue } from './CareerToday';

const items = [
  { kind: 'review', priority: 1, title: '批准给甲公司的投递邮件', detail: '附简历 PDF', ref: { type: 'action', id: 'act1' } },
  { kind: 'deadline', priority: 2, title: '乙公司测评截止', due_at: '2099-01-01T18:00:00', ref: { type: 'deadline', id: 'd1' }, suggest: '帮我看看乙公司的测评怎么准备' },
  { kind: 'stale', priority: 3, title: '丙公司 · 后端工程师 已静默 14 天', ref: { type: 'application', id: 'a1' } },
  { kind: 'inbox', priority: 4, title: '收件箱有 2 条没看懂', ref: { type: 'inbox_item', id: 'i1' }, suggest: '帮我处理收件箱' },
];
const waiting = { count: 5, by_stage: [{ stage: 'applied', n: 3 }, { stage: 'interview', n: 2 }] };
const actions = [{ id: 'act1', application_id: 'a9', kind: 'send_mail', payload_json: JSON.stringify({ subject: '应聘后端工程师 - 张三', to: 'hr@jia.com' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' }];
const checklistPartial = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: false, has_job: false, has_application: false, has_material: false };
const checklistDone = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };

function mockGet(opts: { empty?: boolean; done?: boolean } = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/today')) return opts.empty ? { ok: true, items: [], waiting: { count: 0, by_stage: [] }, inbox_new: 0, pending_review: 0 } : { ok: true, items, waiting, inbox_new: 2, pending_review: 1 };
    if (path.startsWith('/api/career/onboarding')) return { ok: true, checklist: opts.done ? checklistDone : checklistPartial };
    if (path.startsWith('/api/career/actions')) return { ok: true, actions: opts.empty ? [] : actions };
    return { ok: true };
  });
}

describe('CareerToday', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('formatDue：已过期 / 今天 / 明天 / x 天后', () => {
    const now = new Date(2026, 9, 3, 9, 0);
    expect(formatDue('2026-10-02T10:00:00', now)).toBe('已过期');
    expect(formatDue('2026-10-03T18:30:00', now)).toBe('今天 18:30');
    expect(formatDue('2026-10-04T08:00:00', now)).toBe('明天');
    expect(formatDue('2026-10-10T08:00:00', now)).toBe('7 天后');
    expect(formatDue(null, now)).toBeNull();
  });

  it('前三件事渲染为卡片，其余折叠；起步清单显示未完成步骤', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('批准给甲公司的投递邮件')).toBeInTheDocument();
    expect(screen.getByText('乙公司测评截止')).toBeInTheDocument();
    expect(screen.getByText('丙公司 · 后端工程师 已静默 14 天')).toBeInTheDocument();
    // 第四条折叠在"其他待办"里
    expect(screen.queryByText('收件箱有 2 条没看懂')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '其他待办 (1)' }));
    expect(screen.getByText('收件箱有 2 条没看懂')).toBeInTheDocument();
    // send_mail 的待批准：显示动作类型、收件人与"批准并发送"
    expect(screen.getByText('发送投递邮件')).toBeInTheDocument();
    expect(screen.getByText('收件人：hr@jia.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准并发送' })).toBeInTheDocument();
    // 起步清单：2 / 5，未完成的三步可见
    expect(screen.getByText('已完成 2 / 5')).toBeInTheDocument();
    expect(screen.getByText('绑定邮箱，让面试邀请自动进来')).toBeInTheDocument();
    expect(screen.getByText('丢第一个 JD 进收件箱')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我把一个 JD 贴给你，帮我评估值不值得投' })).toBeInTheDocument();
    // 等待中
    expect(screen.getByText('等待中（5）')).toBeInTheDocument();
    expect(screen.getByText('已投递 3')).toBeInTheDocument();
  });

  it('批准并发送 → POST actions/review decision=approved', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, n: 1 });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '批准并发送' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
  });

  it('关闭这条线 → POST applications/:id/close-silent；再等等只在本地隐藏', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, application: { id: 'a1' } });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭这条线' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/applications/a1/close-silent', { note: undefined }));
  });

  it('再等等把静默条隐藏，后面的待办顶上来', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '再等等' }));
    expect(screen.queryByText('丙公司 · 后端工程师 已静默 14 天')).not.toBeInTheDocument();
    expect(screen.getByText('收件箱有 2 条没看懂')).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('完成截止 → POST deadlines/:id/status done；suggest 按钮真的发进对话并带 ref', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, deadline: { id: 'd1' } });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '完成' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/deadlines/d1/status', { status: 'done' }));
    const seen: Array<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '帮我看看乙公司的测评怎么准备' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toMatchObject({ surface: 'today', refs: { deadline_id: 'd1' } });
    off();
  });

  it('清单完成且无待办 → 平静空态；data-changed 后重新拉取', async () => {
    mockGet({ empty: true, done: true });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('今天没有必须做的事。')).toBeInTheDocument();
    expect(screen.queryByText(/已完成 \d \/ 5/)).not.toBeInTheDocument();
    const before = vi.mocked(apiGetJson).mock.calls.filter(c => String(c[0]).startsWith('/api/career/today')).length;
    act(() => { emitEvent('career:data-changed', { tables: ['deadline'] }); });
    await waitFor(() => expect(vi.mocked(apiGetJson).mock.calls.filter(c => String(c[0]).startsWith('/api/career/today')).length).toBe(before + 1));
  });
});
