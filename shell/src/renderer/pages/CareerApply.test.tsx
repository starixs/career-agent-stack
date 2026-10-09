import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerApply from './CareerApply';

const board = {
  due: [{ id: 'a1', job_id: 'j1', stage: 'approved', next_action: '填写网申', next_action_due: '2026-10-03', title: '后端工程师', company_name: '丙公司', deadline: null }],
  blocked: [{ id: 'a2', job_id: 'j2', stage: 'blocked', blocker_reason: '需要验证码', retry_strategy: '明早重试', title: '算法工程师', company_name: '丁公司' }],
  funnel: [{ stage: 'applied', n: 3 }, { stage: 'interview', n: 1 }],
  pendingReview: 1,
};
const review = { attention: 1, requiredTotal: 2, requiredFilled: 1, rows: [
  { fieldId: 'f0', label: '姓名', required: true, status: 'ok', value: '张三', source: 'profile' },
  { fieldId: 'f1', label: '紧急联系人', required: true, status: 'empty', reason: '必填项还是空的' },
] };
const actions = [
  { id: 'act1', application_id: 'a1', kind: 'submit', payload_json: JSON.stringify({ submitButton: '提交申请', review }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' },
  { id: 'act2', application_id: 'a2', kind: 'send_mail', payload_json: JSON.stringify({ subject: '应聘算法工程师', to: 'hr@d.com' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' },
];
const uncertain = { id: 'act9', application_id: 'a1', kind: 'submit', payload_json: '{}', status: 'needs_user', result_json: JSON.stringify({ message: '点了提交，但没等到成功提示' }), reviewed_at: null, approved_by: 'learned', created_at: '2026-10-01', updated_at: '2026-10-01' };
const jobs = [
  { id: 'j1', source_platform: 'boss', title: '后端工程师', company_name: '丙公司', location: '上海', salary: '20-30K', score_json: JSON.stringify({ total: 4.2 }), deadline: '2026-10-10', deadline_verified_at: null, url: 'https://example.com/j1' },
  { id: 'j2', source_platform: 'boss', title: '算法工程师', company_name: '丁公司', location: null, salary: null, score_json: null, deadline: null },
];
const applications = [
  { id: 'a1', job_id: 'j1', stage: 'approved', next_action: '填写网申', next_action_due: '2026-10-03', page_url: null },
  { id: 'a2', job_id: 'j2', stage: 'blocked', blocker_reason: '需要验证码', retry_strategy: '明早重试', page_url: null },
];

const boardRows = [
  { job: { ...jobs[0], employment_type: 'campus', cohort: '2027届', job_key: 'boss:1' }, application: { id: 'a1', stage: 'approved', next_action: '填写网申', updated_at: '2026-10-01' },
    match: { score: 76, hard_ok: true, hard: [{ rule: 'city', label: '城市', ok: true, detail: '上海 在工作地点里' }], covered: 1, total: 2, summary: '2 项要求里有 1 项能用你的经历证明', computed_at: '2026-10-01',
      requirements: [{ requirement: '熟练使用 SQL', weight: 2, status: 'covered', terms: ['SQL'], evidence: { id: 'clm_1', kind: 'claim', text: '在 Hive 上写 SQL 做留存分析', label: '电商数据实习' } }, { requirement: 'Go', weight: 1, status: 'missing', terms: ['Go'] }] } },
  { job: { ...jobs[1], employment_type: 'intern', cohort: null }, application: null, match: null },
];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/board')) return empty ? { ok: true, board: { due: [], blocked: [], funnel: [], pendingReview: 0 } } : { ok: true, board };
    if (path.startsWith('/api/career/actions?status=needs_user')) return { ok: true, actions: empty ? [] : [uncertain] };
    if (path.startsWith('/api/career/actions')) return { ok: true, actions: empty ? [] : actions };
    if (path.startsWith('/api/career/apply/settings')) return { ok: true, auto_mode: false, learn_threshold: 3 };
    if (path.startsWith('/api/career/jobs/board')) return { ok: true, rows: empty ? [] : boardRows, prefs: { cohort: '2027届', cities: ['上海'] }, server: false };
    if (path.startsWith('/api/career/jobs')) return { ok: true, jobs: empty ? [] : jobs };
    if (path.startsWith('/api/career/applications')) return { ok: true, applications: empty ? [] : applications };
    return { ok: true };
  });
}

describe('CareerApply', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('空状态', async () => {
    mockGet(true);
    render(<CareerApply />);
    expect(await screen.findByText('没有符合筛选的岗位')).toBeInTheDocument();
    expect(screen.getByText('今天没有到期事项')).toBeInTheDocument();
    expect(screen.getByText('没有进行中的浏览器任务')).toBeInTheDocument();
  });

  it('渲染看板三问题、待审核动作与岗位池', async () => {
    mockGet();
    render(<CareerApply />);
    expect(await screen.findByText('今天必须做（1）')).toBeInTheDocument();
    expect(screen.getByText('原因：需要验证码')).toBeInTheDocument();
    expect(screen.getByText('重试策略：明早重试')).toBeInTheDocument();
    expect(screen.getByText('停在「提交申请」前，批准后产品替你点提交')).toBeInTheDocument();
    // 审阅清单：需要看的项先展示，已填好的收起
    expect(screen.getByText('紧急联系人')).toBeInTheDocument();
    expect(screen.getByText('必填为空')).toBeInTheDocument();
    expect(screen.queryByText('张三')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('查看已填好的 1 项'));
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getByText('应聘算法工程师 → hr@d.com')).toBeInTheDocument();
    // 岗位汇总表：匹配分点开看"哪条要求对应哪段经历"
    expect(await screen.findByText('我的条件：2027届 · 上海')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('匹配详情 后端工程师'));
    expect(screen.getByText('熟练使用 SQL')).toBeInTheDocument();
    expect(screen.getByText(/电商数据实习：「在 Hive 上写 SQL 做留存分析」/)).toBeInTheDocument();
    expect(screen.getByText('暂无证据')).toBeInTheDocument();
  });

  it('勾选动作后批准调用 actions/review', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, n: 1 });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('选择动作 act1'));
    fireEvent.click(screen.getByRole('button', { name: '批准（1）' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
  });

  it('全选后一次批准全部；auto 模式开关；结果不确定的提交等你确认', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, n: 2 });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('全选'));
    fireEvent.click(screen.getByRole('button', { name: '批准（2）' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1', 'act2'], decision: 'approved' }));
    fireEvent.click(screen.getByLabelText('auto 模式'));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/apply/settings', { auto_mode: true }));
    expect(screen.getByText('点了提交，但没等到成功提示')).toBeInTheDocument();
    expect(screen.getByText('（自学习免确认）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已投递成功' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/act9/confirm-submit', { submitted: true }));
  });

  it('行内只展示允许的目标阶段，切换后调用 applications/:id/stage', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('切换阶段 后端工程师'));
    // approved → pending / applied / blocked / needs_user / skip（STAGE_TRANSITIONS）
    for (const label of ['投递中', '已投递', '需要你', '跳过']) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Offer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '已评估' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已投递' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/applications/a1/stage', { to: 'applied', note: undefined }));
  });

  it('岗位汇总表：全选后加入待投清单', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, queued: 2, results: [{ job_id: 'j1', ok: true }, { job_id: 'j2', ok: true }] });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('全选岗位'));
    fireEvent.click(screen.getByRole('button', { name: '加入待投清单（2）' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/prepare', { job_ids: ['j1', 'j2'] }));
    expect(await screen.findByText(/已加入待投清单 2 个/)).toBeInTheDocument();
  });

  it('导入岗位链接调用 jobs/import', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, job: { id: 'j3' } });
    render(<CareerApply />);
    const input = await screen.findByLabelText('导入岗位链接');
    fireEvent.change(input, { target: { value: 'https://example.com/job/3' } });
    fireEvent.click(screen.getByRole('button', { name: '导入岗位链接' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/import', { url: 'https://example.com/job/3' }));
  });

  it('浏览器状态条：收到 paused 后显示原因，接管动作先经 eventBus 交给 Chat Tab', async () => {
    mockGet();
    render(<CareerApply />);
    await screen.findByText('今天必须做（1）');
    act(() => {
      emitEvent('career:takeover', { sessionId: 's1', runId: 'run1', state: 'paused', reason: 'captcha', url: 'https://example.com/apply' });
    });
    expect(screen.getByText('原因：验证码')).toBeInTheDocument();
    const seen: Array<{ requestId: string; runId: string; action: string }> = [];
    const off = onEvent<{ requestId: string; runId: string; action: string }>('career:takeover-action', p => {
      seen.push(p);
      emitEvent('career:takeover-handled', { requestId: p.requestId, ok: true });
    });
    fireEvent.click(screen.getByRole('button', { name: '接管' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ runId: 'run1', action: 'take' });
    expect(await screen.findByText('你在操作')).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalledWith('/api/career/browser/control', expect.anything());
    off();
  });
});
