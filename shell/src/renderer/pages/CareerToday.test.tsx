import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import { ONBOARDING_INTRO_KEY } from '@/components/career/OnboardingIntro';
import { localDateKey } from '@/components/career/todoCalendar';
import CareerToday, { formatDue } from './CareerToday';

// Node ≥ 25 自带的 localStorage 全局在没有 --localstorage-file 时是 undefined，会盖住 jsdom 的；这里换成内存版。
const memory = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => { memory.clear(); },
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() { return memory.size; },
} as Storage;
vi.stubGlobal('localStorage', memoryStorage);
if (window.localStorage !== memoryStorage) Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage });

const now = new Date();
const todayKey = localDateKey(now);
const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const tomorrowKey = localDateKey(tomorrow);
const cellName = (d: Date) => new RegExp(`^${d.getMonth() + 1}月${d.getDate()}日`);

const items = [
  { kind: 'review', priority: 2, title: '待你批准：发送投递邮件 · 甲公司', ref: { type: 'action', id: 'act1' } },
  { kind: 'review', priority: 2, title: '待你批准：提交 · 丁公司', ref: { type: 'action', id: 'act2' } },
  { kind: 'stale', priority: 6, title: '丙公司 · 后端工程师 已静默 14 天', ref: { type: 'application', id: 'a1' } },
  { kind: 'handoff', priority: 3, title: '需要你本人处理：captcha', ref: { type: 'handoff', id: 'h1' } },
];
const actions = [
  { id: 'act1', application_id: 'a9', kind: 'send_mail', payload_json: JSON.stringify({ subject: '应聘后端工程师 - 张三', to: 'hr@jia.com' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: `${todayKey}T08:00:00`, updated_at: `${todayKey}T08:00:00` },
  { id: 'act2', application_id: null, kind: 'submit', payload_json: '{}', status: 'pending_review', result_json: null, reviewed_at: null, created_at: `${todayKey}T08:00:00`, updated_at: `${todayKey}T08:00:00` },
];
const deadlines = [
  { id: 'd1', kind: 'assessment', title: '乙公司测评截止', due_at: `${tomorrowKey}T18:00:00`, application_id: null, job_id: null, interview_id: null, offer_id: null, source: 'chat', status: 'open', url: null, note: null, created_at: `${todayKey}T08:00:00`, updated_at: `${todayKey}T08:00:00` },
];
const waiting = { count: 5, by_stage: [{ stage: 'applied', n: 3 }] };
const checklistPartial = { has_experience: true, has_confirmed_claim: true, has_master_resume: false, has_mail_account: false, has_job: false, has_application: false, has_material: false };
const checklistDone = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };

interface MockState { items: unknown[]; actions: unknown[]; deadlines: unknown[]; checklist: unknown; needsUser: unknown[] }
let state: MockState;

function mockGet(over: Partial<MockState> = {}) {
  state = { items, actions, deadlines, checklist: checklistDone, needsUser: [], ...over };
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/today')) return { ok: true, items: state.items, waiting, inbox_new: 0, pending_review: state.actions.length };
    if (path.startsWith('/api/career/onboarding')) return { ok: true, checklist: state.checklist };
    if (path.startsWith('/api/career/actions?status=pending_review')) return { ok: true, actions: state.actions };
    if (path.startsWith('/api/career/actions?status=needs_user')) return { ok: true, actions: state.needsUser };
    if (path.startsWith('/api/career/deadlines')) return { ok: true, deadlines: state.deadlines };
    if (path.startsWith('/api/career/activity')) return { ok: true, entries: [] };
    return { ok: true };
  });
}

const sidebar = () => screen.getByRole('complementary', { name: '当天待办' });

describe('CareerToday · 招聘概览', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    window.localStorage.clear();
    window.localStorage.setItem(ONBOARDING_INTRO_KEY, '1');
  });

  it('formatDue：已过期 / 今天 / 明天 / x 天后', () => {
    const at = new Date(2026, 9, 3, 9, 0);
    expect(formatDue('2026-10-02T10:00:00', at)).toBe('已过期');
    expect(formatDue('2026-10-03T18:30:00', at)).toBe('今天 18:30');
    expect(formatDue('2026-10-04T08:00:00', at)).toBe('明天');
    expect(formatDue('2026-10-10T08:00:00', at)).toBe('7 天后');
    expect(formatDue(null, at)).toBeNull();
  });

  it('月历每天最多三类，每类一行只写第一件 + 剩余数；侧栏默认是今天并按类分组', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '招聘概览' })).toBeInTheDocument();
    expect(await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司')).toBeInTheDocument();

    const todayCell = screen.getByRole('button', { name: cellName(now) });
    const lines = todayCell.querySelectorAll('[data-category]');
    expect([...lines].map(l => l.getAttribute('data-category'))).toEqual(['review', 'handoff', 'remind']);
    expect(lines[0]).toHaveTextContent('待你批准：发送投递邮件 · 甲公司');
    expect(lines[0]).toHaveTextContent('+1');
    expect(lines[0]).toHaveAttribute('data-lit', 'true');

    // 侧栏三组 + 动作
    const side = sidebar();
    expect(within(side).getByRole('region', { name: '待批准' })).toBeInTheDocument();
    expect(within(side).getByRole('region', { name: '需要你处理' })).toBeInTheDocument();
    expect(within(side).getByRole('region', { name: '提醒' })).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: '批准并发送' })).toBeInTheDocument();
    expect(within(side).getByText(/收件人：hr@jia.com/)).toBeInTheDocument();

    // 截止放在到期那天；点那一格，侧栏切过去
    const tomorrowCell = screen.getByRole('button', { name: cellName(tomorrow) });
    expect(tomorrowCell).toHaveTextContent('乙公司测评截止');
    fireEvent.click(tomorrowCell);
    expect(tomorrowCell).toHaveAttribute('aria-pressed', 'true');
    expect(within(sidebar()).getByText('乙公司测评截止')).toBeInTheDocument();
    expect(within(sidebar()).queryByText('丙公司 · 后端工程师 已静默 14 天')).not.toBeInTheDocument();
  });

  it('不再有起步清单、等待中与三卡片；底部是页面输入框', async () => {
    mockGet({ checklist: checklistPartial });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    expect(screen.queryByText('起步：五步跑通第一条投递')).not.toBeInTheDocument();
    expect(screen.queryByText(/等待中（/)).not.toBeInTheDocument();
    expect(screen.getByTestId('page-ask-bar')).toBeInTheDocument();
  });

  it('批准并发送 → POST actions/review；这一行被划掉（动画）并留在原位，刷新后仍是已完成', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockImplementation(async () => {
      state = { ...state, actions: state.actions.filter(a => (a as { id: string }).id !== 'act1'), items: state.items.filter(i => (i as { ref: { id: string } }).ref.id !== 'act1') };
      return { ok: true, n: 1 };
    });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await within(sidebar()).findByRole('button', { name: '批准并发送' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
    const row = await waitFor(() => {
      const el = document.querySelector('[data-todo="action:act1"]');
      expect(el).toHaveAttribute('data-done', 'true');
      return el as HTMLElement;
    });
    expect(within(row).getByTestId('strike-line')).toHaveAttribute('data-animate', 'true');
    expect(within(row).getByText('已批准')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    // 服务端已不再返回它，本地仍保留划掉的那行
    await waitFor(() => expect(vi.mocked(apiGetJson).mock.calls.filter(c => String(c[0]).startsWith('/api/career/today')).length).toBeGreaterThan(1));
    expect(document.querySelector('[data-todo="action:act1"]')).toHaveAttribute('data-done', 'true');
  });

  it('完成截止 → POST deadlines/:id/status done；那天全做完后月历圆点变灰', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, deadline: { id: 'd1' } });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    const tomorrowCell = screen.getByRole('button', { name: cellName(tomorrow) });
    fireEvent.click(tomorrowCell);
    expect(tomorrowCell.querySelector('[data-category="remind"]')).toHaveAttribute('data-lit', 'true');
    fireEvent.click(within(sidebar()).getByRole('button', { name: '完成' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/deadlines/d1/status', { status: 'done' }));
    await waitFor(() => expect(document.querySelector('[data-todo="deadline:d1"]')).toHaveAttribute('data-done', 'true'));
    expect(screen.getByRole('button', { name: cellName(tomorrow) }).querySelector('[data-category="remind"]')).toHaveAttribute('data-lit', 'false');
  });

  it('关闭这条线 → POST close-silent；再等等只在本地隐藏', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, application: { id: 'a1' } });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await within(sidebar()).findByRole('button', { name: '再等等' }));
    expect(within(sidebar()).queryByText('丙公司 · 后端工程师 已静默 14 天')).not.toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('data-changed 后重新拉取', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    const before = vi.mocked(apiGetJson).mock.calls.filter(c => String(c[0]).startsWith('/api/career/deadlines')).length;
    act(() => { emitEvent('career:data-changed', { tables: ['deadline'] }); });
    await waitFor(() => expect(vi.mocked(apiGetJson).mock.calls.filter(c => String(c[0]).startsWith('/api/career/deadlines')).length).toBe(before + 1));
  });

  it('翻月：下个月 / 今天', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    const heading = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下个月' }));
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });
});

describe('CareerToday · 新手引导', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    window.localStorage.clear();
  });

  it('第一次打开自动弹出：做完的划掉、放大第一件没做的；跳过后记住，不再自动弹', async () => {
    mockGet({ checklist: checklistPartial });
    const { unmount } = render(<CareerToday isActive onOpenChat={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: '五步跑通第一条投递' });
    const experience = dialog.querySelector('[data-step="experience"]') as HTMLElement;
    expect(within(experience).getByTestId('strike-line')).toBeInTheDocument();
    expect(dialog.querySelector('[data-step="resume"]')).toHaveAttribute('data-focus', 'true');
    expect(dialog.querySelectorAll('[data-focus="true"]')).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '跳过' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ONBOARDING_INTRO_KEY)).toBe('1');
    unmount();

    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 页头「新手引导」随时再打开
    fireEvent.click(screen.getByRole('button', { name: '新手引导' }));
    expect(screen.getByRole('dialog', { name: '五步跑通第一条投递' })).toBeInTheDocument();
  });

  it('开始第一步 → 把那一步的话发进对话并关闭', async () => {
    mockGet({ checklist: checklistPartial });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    const seen: Array<{ text: string; context?: { surface?: string } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(within(dialog).getByRole('button', { name: '开始第一步' }));
    off();
    expect(seen).toEqual([expect.objectContaining({ text: '帮我生成主简历', context: expect.objectContaining({ surface: 'today' }) })]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ONBOARDING_INTRO_KEY)).toBe('1');
  });

  it('五步都做完时不自动弹出', async () => {
    mockGet({ checklist: checklistDone });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    await waitFor(() => expect(screen.getByRole('button', { name: '新手引导' })).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('页面输入框带上选中那一天（refs.date）', async () => {
    mockGet();
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    await within(sidebar()).findByText('待你批准：发送投递邮件 · 甲公司');
    fireEvent.click(screen.getByRole('button', { name: cellName(tomorrow) }));
    const seen: Array<{ context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.change(screen.getByLabelText('问助理'), { target: { value: '这天有什么' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给助理' }));
    off();
    expect(seen[0].context).toEqual({ surface: 'page:career-today', refs: { date: tomorrowKey } });
  });

  it('批准后等你发出去的招呼语：侧栏摆出原文和「复制」，点了才写剪贴板', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockGet({
      needsUser: [
        { id: 'g1', application_id: null, kind: 'send_greeting', payload_json: JSON.stringify({ text: '旧稿' }), status: 'needs_user', result_json: JSON.stringify({ handed_to_user: true, message: '已批准，招呼语需要你本人在平台发送：您好，我是张三，想了解一下贵司的后端岗位', text: '您好，我是张三，想了解一下贵司的后端岗位' }), reviewed_at: null, created_at: `${todayKey}T08:00:00`, updated_at: `${todayKey}T09:00:00` },
        { id: 'f1', application_id: null, kind: 'fill_form', payload_json: '{}', status: 'needs_user', result_json: null, reviewed_at: null, created_at: `${todayKey}T08:00:00`, updated_at: `${todayKey}T09:00:00` },
      ],
    });
    render(<CareerToday isActive onOpenChat={vi.fn()} />);
    const row = (await within(sidebar()).findByText('等你发出去：招呼语')).closest('li')!;
    expect(within(row).getByText('您好，我是张三，想了解一下贵司的后端岗位')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '打开对话接手' })).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: '复制' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('您好，我是张三，想了解一下贵司的后端岗位'));
    expect(await within(row).findByRole('button', { name: '已复制' })).toBeInTheDocument();
    // 其它 needs_user 动作（填表交接走今日队列）不在这里重复出现
    expect(within(sidebar()).queryByText(/等你确认：这条投递/)).not.toBeInTheDocument();
    // 我已发送 → POST mark-sent，这一行划掉并记下「已发送」
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, action: { id: 'g1', status: 'done' } });
    fireEvent.click(within(row).getByRole('button', { name: '我已发送' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/g1/mark-sent', {}));
    expect(await within(sidebar()).findByText('已发送')).toBeInTheDocument();
  });
});
