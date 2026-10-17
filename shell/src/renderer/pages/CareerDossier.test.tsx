import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerApply', () => ({ default: () => <div data-testid="embedded-apply" /> }));
vi.mock('@/pages/CareerInterview', () => ({ default: () => <div data-testid="embedded-interview" /> }));
vi.mock('@/pages/CareerOffer', () => ({ default: () => <div data-testid="embedded-offer" /> }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerDossier from './CareerDossier';

const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
const interviewDeadline = {
  id: 'd1', kind: 'interview', title: '技术一面', due_at: tomorrow, application_id: 'a1', job_id: 'j1', interview_id: null, offer_id: null,
  source: 'mail', status: 'open', url: 'https://meet.example.com/abc', note: null, created_at: '2026-10-01', updated_at: '2026-10-01',
};
const summaries = [
  { application_id: 'a1', job_id: 'j1', company_name: '丙公司', title: '后端工程师', stage: 'interview', updated_at: '2026-10-01', days_since_update: 2, next_deadline: interviewDeadline, interview_count: 1, resume_tailored_id: 'rt1', closed: false,
    created_at: '2026-09-20', applied_at: '2026-09-21T02:00:00.000Z', reached_stages: ['evaluated', 'applied', 'responded', 'interview'], exam_kinds: ['written_test'], job_url: 'https://example.com/j1' },
  { application_id: 'a2', job_id: 'j2', company_name: '丁公司', title: '算法工程师', stage: 'applied', updated_at: '2026-09-13', days_since_update: 20, next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: false,
    created_at: '2026-09-10', applied_at: '2026-09-11T02:00:00.000Z', reached_stages: ['evaluated', 'applied'], exam_kinds: [], job_url: null },
  { application_id: 'a3', job_id: 'j3', company_name: '戊公司', title: '数据工程师', stage: 'rejected', updated_at: '2026-09-01', days_since_update: 32, next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: true,
    created_at: '2026-08-20', applied_at: '2026-08-21T02:00:00.000Z', reached_stages: ['evaluated', 'applied', 'rejected'], exam_kinds: ['written_test'], job_url: 'https://example.com/j3' },
  // 还没投出去
  { application_id: 'a4', job_id: 'j4', company_name: '己公司', title: '运营', stage: 'approved', updated_at: '2026-10-05', days_since_update: 0, next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: false,
    created_at: '2026-10-05', applied_at: null, reached_stages: ['evaluated', 'ready', 'approved'], exam_kinds: [], job_url: null },
];
const past = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const examDeadlines = [
  { ...interviewDeadline, id: 'w1', kind: 'written_test', title: '丙公司笔试', due_at: tomorrow, url: null },
  { ...interviewDeadline, id: 'w2', kind: 'assessment', title: '戊公司测评', due_at: past, application_id: 'a3', job_id: 'j3', status: 'missed', url: null },
  { ...interviewDeadline, id: 'w3', kind: 'written_test', title: '取消的笔试', status: 'cancelled' },
  interviewDeadline,
];

const dossierA1 = {
  application: { id: 'a1', job_id: 'j1', resume_tailored_id: 'rt1', stage: 'interview', next_action: null, next_action_due: null, blocker_reason: null, retry_strategy: null, submission_evidence: null, answers_used_json: '{}', page_url: null, created_at: '2026-09-20', updated_at: '2026-10-01' },
  job: { id: 'j1', source_platform: 'boss', title: '后端工程师', company_name: '丙公司', location: '上海', url: 'https://example.com/j1', jd_raw: '岗位职责：负责核心交易接口开发' },
  company: null,
  resume: { kind: 'tailored', id: 'rt1', schema: { basics: { name: '张三' }, experience: [{ title: 'x' }], projects: [{}, {}] }, confirmed: true },
  answers_used: { 为什么选择我们: '看重基础设施方向的投入' },
  material_uses: [{ id: 'u1', material_id: 'm1', application_id: 'a1', job_id: 'j1', company_name: '丙公司', context: 'form', content_snapshot: '我选择丙公司是因为…', used_at: '2026-09-21' }],
  notes: [
    { id: 'n1', application_id: 'a1', kind: 'said', round: 'first', content: '去年把核心接口 QPS 从 1 万提到 3 万', created_at: '2026-09-28' },
    { id: 'n2', application_id: 'a1', kind: 'heard', round: null, content: '团队今年要扩到 12 人', created_at: '2026-09-28' },
  ],
  deadlines: [interviewDeadline],
  interviews: [{ id: 'iv1', application_id: 'a1', company_name: '丙公司', title: '后端工程师', round: 'first', date: '2026-09-28T14:00:00', interviewer_role_guess: '组长', transcript: null, tags_json: '[]', retro_json: null, result: 'advanced', result_source: 'official', created_at: '2026-09-28', updated_at: '2026-09-28' }],
  offers: [],
  history: [{ from_stage: 'applied', to_stage: 'responded', note: null, created_at: '2026-09-25' }, { from_stage: 'responded', to_stage: 'interview', note: '收到一面邀约', created_at: '2026-09-26' }],
  mails: [{ id: 'mail1', account_id: 'acc', uid: 1, message_id: null, in_reply_to: null, direction: 'in', from_addr: 'hr@bing.com', to_addr: 'me@x.com', subject: '一面邀约：后端工程师', snippet: '请于明天下午两点参加面试', body_text: null, received_at: '2026-09-26T10:00:00', relevance: 'job', kind: 'interview_invite', inbox_item_id: null, application_id: 'a1', action_id: null, created_at: '2026-09-26' }],
  actions: [{ id: 'act1', application_id: 'a1', kind: 'send_mail', payload_json: JSON.stringify({ to: 'hr@bing.com', subject: '感谢一面机会', summary: '一面后的感谢信' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-09-29', updated_at: '2026-09-29' }],
  predictions: [{ id: 'p1', resume_tailored_id: 'rt1', claim_id: null, statement: 'QPS 提升的压测方法会被追问', target_type: 'claim', expected_chain_json: '[]', risk: 'high', created_at: '2026-09-27' }],
};

const dossierA2 = {
  application: { id: 'a2', job_id: 'j2', resume_tailored_id: null, stage: 'applied', answers_used_json: '{}', created_at: '2026-09-10', updated_at: '2026-09-13' },
  job: { id: 'j2', source_platform: 'liepin', title: '算法工程师', company_name: '丁公司' },
  company: { id: 'c2', legal_name: '丁科技有限公司', brand_names: '[]', dd_report_json: null, traffic_light: 'yellow', manual_checks: JSON.stringify(['核实社保缴纳主体']), updated_at: '2026-09-10' },
  resume: null, answers_used: null, material_uses: [], notes: [], deadlines: [], interviews: [], offers: [], history: [], mails: [], actions: [], predictions: [],
};

const interviewRows = [
  { id: 'iv9', application_id: 'a2', company_name: '丁公司', title: '算法工程师', round: 'second', date: new Date(Date.now() + 72 * 3600 * 1000).toISOString(), interviewer_role_guess: null, transcript: null, tags_json: '[]', retro_json: null, result: 'none', result_source: 'none', created_at: '2026-10-01', updated_at: '2026-10-01' },
];
const mockRows = [
  { id: 'mk1', job_id: 'j1', resume_tailored_id: null, mode: 'probe', company_type: null, round: 'first', turns_json: '[]', report_json: null, created_at: '2026-10-02T02:00:00.000Z', updated_at: '2026-10-02T02:00:00.000Z' },
];

function mockGet({ exams = [] as unknown[], interviews = [] as unknown[], mocks = [] as unknown[], mailAccounts = [] as unknown[] } = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/dossiers/a1')) return { ok: true, dossier: dossierA1 };
    if (path.startsWith('/api/career/dossiers/a2')) return { ok: true, dossier: dossierA2 };
    if (path.startsWith('/api/career/dossiers')) return { ok: true, dossiers: summaries };
    if (path.startsWith('/api/career/deadlines')) return { ok: true, deadlines: exams };
    if (path.startsWith('/api/career/exam-practices')) return { ok: true, examPractices: [] };
    if (path.startsWith('/api/career/interviews')) return { ok: true, interviews };
    if (path.startsWith('/api/career/mock-interviews')) return { ok: true, mockInterviews: mocks };
    if (path.startsWith('/api/career/mail/accounts')) return { ok: true, accounts: mailAccounts, presets: {} };
    return { ok: true };
  });
}

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);


describe('CareerDossier · 投递记录', () => {
  beforeEach(() => {
    resetCareerSubViews();
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    mockGet();
  });

  it('默认是一张普通列表：公司 / 岗位 / 投递时间 / 状态，按投递时间倒序；不分组、不自动摊开档案', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['公司', '岗位', '投递时间', '状态']);
    // 没投出的按建档时间排在最前，显示「未投出」
    expect(bodyRows().map(r => r.getAttribute('aria-label'))).toEqual(['己公司 · 运营', '丙公司 · 后端工程师', '丁公司 · 算法工程师', '戊公司 · 数据工程师']);
    expect(within(bodyRows()[0]).getByText('未投出')).toBeInTheDocument();
    expect(within(bodyRows()[1]).getByText('2026-09-21')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '后端工程师' })).not.toBeInTheDocument();
    expect(screen.queryByText(/已关闭（/)).not.toBeInTheDocument();
    // 状态：紧凑步骤条 + 当前步骤文字（被拒停在笔试，不用红色）
    expect(screen.getByRole('button', { name: '投递状态：面试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '投递状态：网申 · 已投递' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '投递状态：笔试 · 未通过' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '投递状态：网申 · 待投' })).toBeInTheDocument();
    expect(screen.getByText('20 天无动静')).toBeInTheDocument();
  });

  it('移到状态上浮出完整步骤条', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    fireEvent.mouseEnter(await screen.findByRole('button', { name: '投递状态：面试' }));
    const full = await screen.findByRole('list', { name: /^投递进度：/ });
    expect(full).toHaveAccessibleName('投递进度：网申已完成，测评没有这一步的记录，笔试已完成，面试进行中，Offer还没到，入职还没到');
    expect(within(full).getAllByRole('listitem').map(li => li.textContent)).toEqual(['网申', '测评', '笔试', '面试', 'Offer', '入职']);
  });

  it('点一行看岗位：JD 原文和岗位页面；不再有档案页；Esc 关闭；没有 JD 原文时给链接', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('row', { name: '丙公司 · 后端工程师' }));
    const dialog = await screen.findByRole('dialog', { name: '后端工程师 的 JD' });
    expect(await within(dialog).findByText('岗位职责：负责核心交易接口开发')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '岗位页面' })).toHaveAttribute('href', 'https://example.com/j1');
    expect(within(dialog).queryByRole('button', { name: '打开档案' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '投的是哪版简历' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('row', { name: '丁公司 · 算法工程师' }));
    expect(await screen.findByText('没有保存这个岗位的 JD 原文。')).toBeInTheDocument();
  });
  it('键盘：行可聚焦，Enter 看岗位', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    const row = await screen.findByRole('row', { name: '丁公司 · 算法工程师' });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: '算法工程师 的 JD' })).toBeInTheDocument();
  });
  it('页面输入框问的是投递整体，不带具体投递', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    const seen: Array<{ context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.change(screen.getByLabelText('问助理'), { target: { value: '这个月投了多少' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给助理' }));
    off();
    expect(seen.map(p => p.context)).toEqual([{ surface: 'page:career-dossier:line', refs: undefined }]);
  });
  it('焦点事件按 job_id 在列表里高亮那一条，不打开档案页；搜索过滤列表', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    act(() => { emitEvent('career:focus', { surface: 'dossier', job_id: 'j2' }); });
    await waitFor(() => expect(screen.getByRole('row', { name: '丁公司 · 算法工程师' }).className).toContain('shadow-[inset_3px_0_0_var(--primary)]'));
    expect(screen.queryByRole('heading', { name: '算法工程师' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索投递线'), { target: { value: '丙' } });
    expect(bodyRows().map(r => r.getAttribute('aria-label'))).toEqual(['丙公司 · 后端工程师']);
  });
  it('二级导航选的子视图决定页标题与嵌入页', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: '投递记录' })).toBeInTheDocument();
    act(() => { setCareerSubView('career-dossier', 'interview'); });
    expect(await screen.findByTestId('embedded-interview')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '面试工作台' })).toBeInTheDocument();
    act(() => { setCareerSubView('career-dossier', 'apply'); });
    expect(await screen.findByTestId('embedded-apply')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '岗位收藏' })).toBeInTheDocument();
    // 旧的「笔试记录」视图落到助力记录
    act(() => { setCareerSubView('career-dossier', 'exam'); });
    expect(await screen.findByText('还没有助力记录')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '助力记录' })).toBeInTheDocument();
  });
});

describe('CareerDossier · 助力记录', () => {
  beforeEach(() => {
    resetCareerSubViews();
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    mockGet({ exams: examDeadlines, interviews: interviewRows, mocks: mockRows });
    act(() => { setCareerSubView('career-dossier', 'assist'); });
  });

  it('笔试 / 测评 / 面试 / 模拟面试合成一张表：公司 / 岗位 / 时间 / 类型 / 助力；还没到的按时间在前；已取消的不列', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['公司', '岗位', '时间', '类型', '操作']);
    const rows = bodyRows();
    // 没到的按时间正序（明天的笔试、后天的二面），其余按时间倒序（两天前过期的测评、10 月 2 日的模拟面试）
    expect(rows.map(r => within(r).getAllByRole('cell')[0].textContent)).toEqual(['丙公司', '丁公司', '戊公司', '丙公司']);
    expect(within(rows[0]).getByText('笔试')).toBeInTheDocument();
    expect(within(rows[1]).getByText('面试')).toBeInTheDocument();
    expect(within(rows[1]).getByText('二面')).toBeInTheDocument();
    expect(within(rows[2]).getByText('测评')).toBeInTheDocument();
    expect(within(rows[2]).getByText('已过')).toBeInTheDocument();
    expect(within(rows[3]).getByText('模拟面试')).toBeInTheDocument();
    expect(within(rows[3]).getByText('深挖追问 · 一面')).toBeInTheDocument();
    expect(screen.queryByText('取消的笔试')).not.toBeInTheDocument();
    rows.forEach(r => expect(within(r).getByRole('button', { name: '助力' })).toBeInTheDocument());
  });

  it('按类型筛选；点一行跳到投递记录里对应那一条', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /^面试 1$/ }));
    expect(bodyRows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^笔试 2$/ }));
    expect(bodyRows().map(r => within(r).getAllByRole('cell')[0].textContent)).toEqual(['丙公司', '戊公司']);
    fireEvent.click(bodyRows()[0]);
    // 跳到投递记录，高亮对应那一条
    expect(await screen.findByRole('heading', { name: '投递记录' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('row', { name: '丙公司 · 后端工程师' }).className).toContain('shadow-[inset_3px_0_0_var(--primary)]'));
  });

  it('助力：笔试把带投递和截止 id 的话发进对话，不打开档案', async () => {
    const suggested: unknown[] = [];
    const off = onEvent('career:chat-suggest', p => suggested.push(p));
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(within(bodyRows()[0]).getByRole('button', { name: '助力' }));
    expect(suggested[0]).toMatchObject({ text: '帮我准备丙公司的笔试', context: { surface: 'dossier', refs: { application_id: 'a1', deadline_id: 'w1' } }, mode: 'send' });
    expect(screen.getByRole('heading', { name: '助力记录' })).toBeInTheDocument();
    off();
  });

  it('新建 › 手动填写笔试：调用 /exams；面试走 /interviews', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建助力记录' });
    fireEvent.change(within(dialog).getByLabelText('公司'), { target: { value: '庚公司' } });
    fireEvent.change(within(dialog).getByLabelText('岗位'), { target: { value: '前端' } });
    fireEvent.change(within(dialog).getByLabelText('时间'), { target: { value: '2026-10-20T14:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/exams', expect.objectContaining({
      company_name: '庚公司', title: '前端', kind: 'written_test', due_at: new Date('2026-10-20T14:00').toISOString(),
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('新建 › 粘贴分享链接：从分享文字里取出链接交给 /inbox/link；认出来了就显示结果', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { item: { id: 'in1' }, summary: '庚公司笔试 10 月 20 日', fetched: false, created: { deadline_ids: ['dl9'] } } });
    const suggested: unknown[] = [];
    const off = onEvent('career:chat-suggest', p => suggested.push(p));
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建助力记录' });
    fireEvent.click(within(dialog).getByRole('tab', { name: /粘贴分享链接/ }));
    fireEvent.change(within(dialog).getByLabelText('分享文字'), { target: { value: '【Boss直聘】庚公司邀请你参加笔试 https://z.example/s/1 复制打开' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '识别' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox/link', { url: 'https://z.example/s/1', text: '【Boss直聘】庚公司邀请你参加笔试 https://z.example/s/1 复制打开' }));
    expect(await within(dialog).findByText('庚公司笔试 10 月 20 日')).toBeInTheDocument();
    expect(suggested).toHaveLength(0);
    off();
  });

  it('新建 › 粘贴分享链接：分享页没抓到、也没认出来时交给小芽用浏览器打开', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { item: { id: 'in2' }, summary: '没看懂', fetched: false, created: { deadline_ids: [] } } });
    const suggested: Array<{ text: string; context?: { refs?: Record<string, string> }; mode?: string }> = [];
    const off = onEvent<{ text: string; context?: { refs?: Record<string, string> }; mode?: string }>('career:chat-suggest', p => suggested.push(p));
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建助力记录' });
    fireEvent.click(within(dialog).getByRole('tab', { name: /粘贴分享链接/ }));
    fireEvent.change(within(dialog).getByLabelText('分享链接'), { target: { value: 'https://www.zhipin.com/share/x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '识别' }));
    expect(await within(dialog).findByText(/已交给小芽用浏览器打开/)).toBeInTheDocument();
    expect(suggested).toHaveLength(1);
    expect(suggested[0].mode).toBe('send');
    expect(suggested[0].text).toContain('https://www.zhipin.com/share/x');
    expect(suggested[0].text).toContain('in2');
    expect(suggested[0].context?.refs).toEqual({ inbox_id: 'in2' });
    off();
  });

  it('邮箱：没绑定时右上角是「绑定邮箱」，打开新建的邮箱页；绑定了就是「同步邮箱」', async () => {
    const { unmount } = render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '绑定邮箱' }));
    const dialog = await screen.findByRole('dialog', { name: '新建助力记录' });
    expect(within(dialog).getByRole('tab', { name: /从邮箱同步/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('button', { name: /QQ 邮箱/ })).toBeInTheDocument();
    unmount();

    mockGet({ exams: examDeadlines, mailAccounts: [{ id: 'acc1', address: 'me@qq.com', provider: 'qq', status: 'ok', last_sync_at: null, last_error: null }] });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, results: [{ account_id: 'acc1', fetched: 3, stored: 3, job_related: 1, ignored: 2, archived: [] }] });
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '同步邮箱' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/sync', { account_id: undefined }));
    expect(await screen.findByText(/拉到 3 封，1 封与求职相关/)).toBeInTheDocument();
  });
});
