import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerApply', () => ({ default: () => <div data-testid="embedded-apply" /> }));
vi.mock('@/pages/CareerInterview', () => ({ default: () => <div data-testid="embedded-interview" /> }));
vi.mock('@/pages/CareerOffer', () => ({ default: () => <div data-testid="embedded-offer" /> }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerDossier from './CareerDossier';

const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
const interviewDeadline = {
  id: 'd1', kind: 'interview', title: '技术一面', due_at: tomorrow, application_id: 'a1', job_id: 'j1', interview_id: null, offer_id: null,
  source: 'mail', status: 'open', url: 'https://meet.example.com/abc', note: null, created_at: '2026-10-01', updated_at: '2026-10-01',
};
const summaries = [
  { application_id: 'a1', job_id: 'j1', company_name: '丙公司', title: '后端工程师', stage: 'interview', updated_at: '2026-10-01', days_since_update: 2, next_deadline: interviewDeadline, interview_count: 1, resume_tailored_id: 'rt1', closed: false },
  { application_id: 'a2', job_id: 'j2', company_name: '丁公司', title: '算法工程师', stage: 'applied', updated_at: '2026-09-13', days_since_update: 20, next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: false },
  { application_id: 'a3', job_id: 'j3', company_name: '戊公司', title: '数据工程师', stage: 'rejected', updated_at: '2026-09-01', days_since_update: 32, next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: true },
];

const dossierA1 = {
  application: { id: 'a1', job_id: 'j1', resume_tailored_id: 'rt1', stage: 'interview', next_action: null, next_action_due: null, blocker_reason: null, retry_strategy: null, submission_evidence: null, answers_used_json: '{}', page_url: null, created_at: '2026-09-20', updated_at: '2026-10-01' },
  job: { id: 'j1', source_platform: 'boss', title: '后端工程师', company_name: '丙公司', location: '上海', url: 'https://example.com/j1' },
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

function mockGet() {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/dossiers/a1')) return { ok: true, dossier: dossierA1 };
    if (path.startsWith('/api/career/dossiers/a2')) return { ok: true, dossier: dossierA2 };
    if (path.startsWith('/api/career/dossiers')) return { ok: true, dossiers: summaries };
    return { ok: true };
  });
}

describe('CareerDossier', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    mockGet();
  });

  it('自动选中第一条进行中的线，摊开面试当天需要的全部信息', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: '后端工程师' })).toBeInTheDocument();
    // 列表：阶段、无动静提示、下一截止；已关闭默认折叠
    expect(screen.getByText('20 天无动静')).toBeInTheDocument();
    expect(screen.getByText('已关闭（1）')).toBeInTheDocument();
    expect(screen.queryByText('戊公司 · 数据工程师')).not.toBeInTheDocument();
    // 面试信息
    expect(screen.getByText('技术一面')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开链接' })).toHaveAttribute('href', 'https://meet.example.com/abc');
    expect(screen.getByText('一面')).toBeInTheDocument();
    expect(screen.getByText('· 进入下一轮')).toBeInTheDocument();
    // 投的是哪版简历
    expect(screen.getByText('定制版')).toBeInTheDocument();
    expect(screen.getByText('张三 · 1 段经历 · 2 个项目')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '预览 PDF' })).toHaveAttribute('href', '/api/career/resumes/rt1/file?format=pdf');
    // 说过的话 / 听到的 / 邮件
    expect(screen.getByText('去年把核心接口 QPS 从 1 万提到 3 万')).toBeInTheDocument();
    expect(screen.getAllByText('我说过').length).toBeGreaterThanOrEqual(2); // 备注徽标 + 记一笔默认类型
    expect(screen.getByText('我选择丙公司是因为…')).toBeInTheDocument();
    expect(screen.getByText('看重基础设施方向的投入')).toBeInTheDocument();
    expect(screen.getByText('团队今年要扩到 12 人')).toBeInTheDocument();
    expect(screen.getByText('一面邀约：后端工程师')).toBeInTheDocument();
    // 没有调研 → 让助理查；预测追问；时间线
    expect(screen.getByRole('button', { name: '帮我查查这家公司靠不靠谱' })).toBeInTheDocument();
    expect(screen.getByText('QPS 提升的压测方法会被追问')).toBeInTheDocument();
    expect(screen.getByText('· 收到一面邀约')).toBeInTheDocument();
  });

  it('待审动作：send_mail 显示收件人与主题，批准并发送调用 actions/review', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, n: 1 });
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('主题：感谢一面机会')).toBeInTheDocument();
    expect(screen.getByText('收件人：hr@bing.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准并发送' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
  });

  it('沉默 14 天以上的线提示关闭，关闭调用 close-silent', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, application: { id: 'a2', stage: 'discarded' } });
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByText('丁公司 · 算法工程师'));
    expect(await screen.findByRole('heading', { name: '算法工程师' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已经 20 天没有动静');
    expect(screen.getByText('黄灯')).toBeInTheDocument();
    expect(screen.getByText('核实社保缴纳主体')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭这条线' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/applications/a2/close-silent', { note: undefined }));
  });

  it('记一笔：提交到 dossiers/:id/notes', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, note: { id: 'n9' } });
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('heading', { name: '后端工程师' });
    fireEvent.change(screen.getByLabelText('轮次'), { target: { value: '二面' } });
    fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '期望薪资说的是 30K' } });
    fireEvent.click(screen.getByRole('button', { name: '记下' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/dossiers/a1/notes', { kind: 'said', round: '二面', content: '期望薪资说的是 30K' }));
  });

  it('改阶段调用 applications/:id/stage，状态机报错显示在页面上', async () => {
    vi.mocked(apiPostJson).mockRejectedValue(new Error('interview → hired 不是允许的流转'));
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('heading', { name: '后端工程师' });
    fireEvent.click(screen.getByLabelText('移动阶段'));
    expect(screen.queryByRole('button', { name: '面试中' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已入职' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/applications/a1/stage', { to: 'hired', note: undefined }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不是允许的流转');
  });

  it('面试模式隐藏待审 / 时间线 / 记一笔；准备面试按钮带 application_id 发进对话', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('heading', { name: '后端工程师' });
    expect(screen.getByText('记一笔')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '面试模式' }));
    expect(screen.queryByText('记一笔')).not.toBeInTheDocument();
    expect(screen.queryByText('时间线')).not.toBeInTheDocument();
    expect(screen.getByText('投的是哪版简历')).toBeInTheDocument();
    const seen: Array<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '帮我准备这场面试' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toMatchObject({ surface: 'dossier', refs: { application_id: 'a1' } });
    off();
  });

  it('焦点事件按 job_id 选中对应的线；搜索过滤列表', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('heading', { name: '后端工程师' });
    act(() => { emitEvent('career:focus', { surface: 'dossier', job_id: 'j2' }); });
    expect(await screen.findByRole('heading', { name: '算法工程师' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索投递线'), { target: { value: '丙' } });
    expect(screen.getByText('丙公司 · 后端工程师')).toBeInTheDocument();
    expect(screen.queryByText('丁公司 · 算法工程师')).not.toBeInTheDocument();
  });

  it('切到面试视图渲染嵌入的面试页', async () => {
    render(<CareerDossier isActive onOpenChat={vi.fn()} />);
    await screen.findByRole('heading', { name: '后端工程师' });
    fireEvent.click(screen.getByRole('tab', { name: '面试' }));
    expect(await screen.findByTestId('embedded-interview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Offer' }));
    expect(await screen.findByTestId('embedded-offer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '岗位池与投递台' }));
    expect(await screen.findByTestId('embedded-apply')).toBeInTheDocument();
  });
});
