import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerInbox, { detectProvider, relativeTime } from './CareerInbox';

const items = [
  { id: 'i1', source: 'paste', raw_text: '某某科技 后端开发实习生 JD：负责服务端开发…', kind: null, status: 'new', parsed_json: null, linked_type: null, linked_id: null, mail_message_id: null, note: '没看出是哪家公司', created_at: '2026-10-02T10:00:00', processed_at: null },
  { id: 'i2', source: 'mail', raw_text: '您好，诚邀您参加甲公司一面…', kind: 'interview_invite', status: 'processed', parsed_json: null, linked_type: 'application', linked_id: 'a1', mail_message_id: 'm1', note: null, created_at: '2026-10-01T09:00:00', processed_at: '2026-10-01T09:01:00' },
  { id: 'i3', source: 'paste', raw_text: '广告', kind: 'other', status: 'dismissed', parsed_json: null, linked_type: null, linked_id: null, mail_message_id: null, note: null, created_at: '2026-09-30', processed_at: null },
];
const accounts = [{ id: 'm1', provider: 'qq', address: 'me@qq.com', display_name: null, imap_host: 'imap.qq.com', imap_port: 993, smtp_host: 'smtp.qq.com', smtp_port: 465, status: 'ok', last_sync_at: null, last_uid: 0, last_error: null, created_at: '2026-10-01', updated_at: '2026-10-01' }];
const presets = { qq: { provider: 'qq', label: 'QQ 邮箱', imap_host: 'imap.qq.com', imap_port: 993, smtp_host: 'smtp.qq.com', smtp_port: 465, help: '在 QQ 邮箱设置 → 账户里开启 IMAP 并生成授权码。' } };
const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
const deadlines = [
  { id: 'd1', kind: 'assessment', title: '乙公司测评截止', due_at: soon, application_id: 'a1', job_id: null, interview_id: null, offer_id: null, source: 'chat', status: 'open', url: null, note: null, created_at: '2026-10-02T12:00:00', updated_at: '2026-10-02T12:00:00' },
  { id: 'd2', kind: 'other', title: '很远的截止', due_at: far, application_id: null, job_id: null, interview_id: null, offer_id: null, source: 'chat', status: 'open', url: null, note: null, created_at: '2026-10-02T13:00:00', updated_at: '2026-10-02T13:00:00' },
];
const actions = [
  { id: 'act1', application_id: 'a1', kind: 'send_mail', payload_json: JSON.stringify({ subject: '应聘后端工程师 - 张三', to: 'hr@jia.com' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-03T08:00:00', updated_at: '2026-10-03T08:00:00' },
];
const dossiers = [{ application_id: 'a1', job_id: 'j1', company_name: '甲公司', title: '后端工程师', stage: 'interview', updated_at: '2026-10-01', days_since_update: 1, next_deadline: null, interview_count: 1, resume_tailored_id: null, closed: false }];

let pendingNow: unknown[] = actions;
function mockGet(opts: { batch?: unknown } = {}) {
  pendingNow = actions;
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/inbox')) return { ok: true, items };
    if (path.startsWith('/api/career/actions?status=pending_review')) return { ok: true, actions: pendingNow };
    if (path.startsWith('/api/career/actions?status=needs_user')) return { ok: true, actions: [] };
    if (path.startsWith('/api/career/deadlines')) return { ok: true, deadlines };
    if (path.startsWith('/api/career/batch/state')) return { ok: true, batch: opts.batch ?? null };
    if (path.startsWith('/api/career/mail/accounts')) return { ok: true, accounts, presets };
    if (path.startsWith('/api/career/dossiers')) return { ok: true, dossiers };
    return { ok: true };
  });
}

describe('CareerInbox', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiDelete).mockReset();
  });

  it('detectProvider / relativeTime', () => {
    expect(detectProvider('a@qq.com')).toBe('qq');
    expect(detectProvider('a@foxmail.com')).toBe('qq');
    expect(detectProvider('a@163.com')).toBe('163');
    expect(detectProvider('a@gmail.com')).toBe('gmail');
    expect(detectProvider('a@hotmail.com')).toBe('outlook');
    expect(detectProvider('a@company.cn')).toBe('imap');
    const now = new Date(2026, 9, 3, 12, 0);
    expect(relativeTime(null, now)).toBe('从未');
    expect(relativeTime(new Date(2026, 9, 3, 11, 30).toISOString(), now)).toBe('30 分钟前');
    expect(relativeTime(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toBe('2 天前');
  });

  it('一条流聚合邮件 / 待批准 / 提醒，新的在前，带类型标签；忽略的收起', async () => {
    mockGet();
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '通知中心' })).toBeInTheDocument();
    expect(await screen.findByText(/某某科技 后端开发实习生 JD/)).toBeInTheDocument();
    expect(await screen.findByText('应聘后端工程师 - 张三 → hr@jia.com')).toBeInTheDocument();
    expect(await screen.findByText('乙公司测评截止')).toBeInTheDocument();
    expect(screen.getByText('没看出是哪家公司')).toBeInTheDocument();
    expect(screen.getByText(/诚邀您参加甲公司一面/)).toBeInTheDocument();
    expect(screen.queryByText('很远的截止')).not.toBeInTheDocument();
    expect(screen.queryByText('广告')).not.toBeInTheDocument();
    // 新的在前：待批准(10-03) → 提醒(10-02 12:00) → 邮件(10-02 10:00) → 邮件(10-01)
    const order = [...document.querySelectorAll('li[data-feed-type]')].map(li => li.getAttribute('data-feed-type'));
    expect(order).toEqual(['review', 'remind', 'mail', 'mail']);
    expect(screen.getByRole('button', { name: '全部 4' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提醒 1' }));
    expect(screen.queryByText(/某某科技 后端开发实习生 JD/)).not.toBeInTheDocument();
    expect(screen.getByText('乙公司测评截止')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全部 4' }));
    fireEvent.click(screen.getByRole('button', { name: '看已忽略的 1 条' }));
    expect(screen.getByText('广告')).toBeInTheDocument();
  });

  it('已归档的邮件可打开卷宗', async () => {
    mockGet();
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    const row = (await screen.findByText(/诚邀您参加甲公司一面/)).closest('[data-inbox-id]') as HTMLElement;
    expect(within(row).getByText('面试邀请')).toBeInTheDocument();
    const focus: Array<{ surface: string; application_id?: string | null }> = [];
    const off = onEvent<{ surface: string; application_id?: string | null }>('career:focus', p => { focus.push(p); });
    fireEvent.click(within(row).getByRole('button', { name: '打开卷宗' }));
    expect(focus).toEqual([{ surface: 'dossier', application_id: 'a1' }]);
    off();
  });

  it('等你批准：批准并发送 → POST actions/review，原地变成「已发送 · 时间」', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockImplementation(async () => { pendingNow = []; return { ok: true, n: 1 }; });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    const review = (await screen.findByText('应聘后端工程师 - 张三 → hr@jia.com')).closest('li') as HTMLElement;
    expect(within(review).getByText('甲公司 · 后端工程师')).toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: '批准并发送' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
    expect(await screen.findByText(/^已发送 · \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准并发送' })).not.toBeInTheDocument();
  });

  it('不发了 → POST decision=rejected；提醒的完成 → POST deadlines/:id/status', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '不发了' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'rejected' }));
    fireEvent.click(await screen.findByRole('button', { name: '完成' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/deadlines/d1/status', { status: 'done' }));
  });

  it('批量投递进行中时在最上面显示进度', async () => {
    mockGet({ batch: { status: 'running', updatedAt: '2026-10-03T08:00:00', done: 2, failed: 0, handoffs: 1, queued: 3, todayCount: 2, message: '正在填丁公司' } });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByTestId('career-card-batch')).toBeInTheDocument();
    expect(screen.getByText('正在填丁公司')).toBeInTheDocument();
    act(() => { emitEvent('career:batch', { status: 'stopped', updatedAt: '2026-10-03T09:00:00', done: 5, failed: 0, handoffs: 0, queued: 0, todayCount: 5 }); });
    expect(screen.queryByTestId('career-card-batch')).not.toBeInTheDocument();
  });

  it('丢进来 → POST /api/career/inbox {text}，显示 summary 与未看懂提示', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { item: { ...items[0], id: 'i9' }, triage: null, created: { deadline_ids: [] }, focus: { surface: 'inbox', id: 'i9' }, summary: '已收下，暂时没识别出类型' } });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    const box = await screen.findByLabelText('丢进通知中心');
    fireEvent.change(box, { target: { value: '  某公司 产品实习生 JD  ' } });
    fireEvent.click(screen.getByRole('button', { name: '丢进来' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox', { text: '某公司 产品实习生 JD' }));
    expect(await screen.findByText('已收下，暂时没识别出类型')).toBeInTheDocument();
    expect(screen.getByText('助理没完全看懂，可以在下面指定归属或交给对话。')).toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('绑定邮箱 → POST /api/career/mail/accounts，显示验证结果；授权码不发给对话', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, account: { ...accounts[0], id: 'm2', address: 'new@163.com' }, verify: { fetched: 12, job_related: 3 } });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('me@qq.com')).toBeInTheDocument();
    expect(screen.getByText('QQ 邮箱')).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '绑定邮箱' }));
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'new@163.com' } });
    fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'secret-code' } });
    expect(screen.getByText(/只保存在本机，不会发给对话/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '绑定并验证' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/accounts', { address: 'new@163.com', password: 'secret-code', display_name: undefined }));
    expect(await screen.findByText('已连接，拉到 12 封，其中 3 封与求职相关')).toBeInTheDocument();
  });

  it('立即同步 → POST mail/sync；解绑需确认后 DELETE', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, results: [{ account_id: 'm1', fetched: 4, stored: 4, job_related: 1, ignored: 3, archived: [] }] });
    vi.mocked(apiDelete).mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '立即同步' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/sync', { account_id: 'm1' }));
    expect(await screen.findByText('拉到 4 封，其中 1 封与求职相关')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解绑' }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/career/mail/accounts/m1'));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('待处理条目：忽略 → POST inbox/:id/dismiss；重新识别可带归属；交给助理带 inbox_id', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, item: { ...items[0], status: 'dismissed' } });
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    const seen: Array<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(await screen.findByRole('button', { name: '帮我处理这条' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toMatchObject({ surface: 'inbox', refs: { inbox_id: 'i1' } });
    off();

    fireEvent.click(screen.getByLabelText('归属投递 i1'));
    fireEvent.click(screen.getByRole('button', { name: '甲公司 · 后端工程师' }));
    fireEvent.click(screen.getByRole('button', { name: '重新识别' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox/i1/retry', { application_id: 'a1' }));

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox/i1/dismiss', {}));
  });

  it('career:focus 带 id 时高亮并切到该条所在筛选', async () => {
    mockGet();
    render(<CareerInbox isActive onOpenChat={vi.fn()} />);
    await screen.findByText(/某某科技 后端开发实习生 JD/);
    act(() => { emitEvent('career:focus', { surface: 'inbox', id: 'i2' }); });
    const row = (await screen.findByText(/诚邀您参加甲公司一面/)).closest('[data-inbox-id]');
    expect(row?.className).toContain('bg-[var(--primary-soft)]');
  });
});
