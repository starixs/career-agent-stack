import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import CareerApply from './CareerApply';

const uncertain = { id: 'act9', application_id: 'a1', kind: 'submit', payload_json: '{}', status: 'needs_user', result_json: JSON.stringify({ message: '点了提交，但没等到成功提示' }), reviewed_at: null, approved_by: 'learned', created_at: '2026-10-01', updated_at: '2026-10-01' };
const applications = [
  { id: 'a1', job_id: 'j1', stage: 'approved', next_action: '填写网申', next_action_due: '2026-10-03', page_url: null, title: '后端工程师', company_name: '丙公司' },
];
const jobs = [
  { id: 'j1', source_platform: 'campus', title: '后端工程师', company_name: '丙公司', location: '上海/北京', salary: null, deadline: '2099-12-10', deadline_verified_at: null, url: 'https://example.com/j1', updated_at: '2026-10-01' },
  { id: 'j2', source_platform: 'campus', title: '算法工程师', company_name: '丁公司', location: '深圳', salary: null, deadline: null, updated_at: '2026-10-02' },
  { id: 'j3', source_platform: 'campus', title: '数据分析', company_name: '戊公司', location: '上海', salary: null, deadline: '2020-01-01', updated_at: '2026-10-03' },
];

const boardRows = [
  { job: { ...jobs[0], employment_type: 'campus', cohort: '2027届', job_key: 'c:1' }, meta: { batch: '正式批', industry: '互联网', type_tags: [] }, application: { id: 'a1', stage: 'approved', next_action: '填写网申', updated_at: '2026-10-01' },
    match: { score: 76, hard_ok: true, hard: [{ rule: 'city', label: '城市', ok: true, detail: '上海 在工作地点里' }], covered: 1, total: 2, summary: '2 项要求里有 1 项能用你的经历证明', computed_at: '2026-10-01',
      requirements: [{ requirement: '熟练使用 SQL', weight: 2, status: 'covered', terms: ['SQL'], evidence: { id: 'clm_1', kind: 'claim', text: '在 Hive 上写 SQL 做留存分析', label: '电商数据实习' } }, { requirement: 'Go', weight: 1, status: 'missing', terms: ['Go'] }] } },
  { job: { ...jobs[1], employment_type: 'intern', cohort: null }, meta: { batch: '实习', industry: null, type_tags: ['央国企'] }, application: null, match: null },
  // 已截止：默认「只看没截止」时不显示
  { job: { ...jobs[2], employment_type: 'campus', cohort: null }, meta: { batch: '正式批', industry: '互联网', type_tags: [] }, application: null, match: null },
];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/actions?status=needs_user')) return { ok: true, actions: empty ? [] : [uncertain] };
    if (path.startsWith('/api/career/apply/settings')) return { ok: true, auto_mode: false, learn_threshold: 3 };
    if (path.startsWith('/api/career/jobs/board')) return { ok: true, rows: empty ? [] : boardRows, prefs: { cohort: '2027届', cities: ['上海'] }, server: false };
    if (path.startsWith('/api/career/applications')) return { ok: true, applications: empty ? [] : applications };
    return { ok: true };
  });
}

const tableRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('CareerApply · 岗位收藏', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('空状态：表格是主体，不再有「等你批准」和投递概况；浏览器空闲时不占位；底部是页面输入框和「AI 找工作」入口', async () => {
    mockGet(true);
    render(<CareerApply />);
    expect(await screen.findByText('没有符合筛选的岗位')).toBeInTheDocument();
    expect(screen.queryByText(/等你批准/)).not.toBeInTheDocument();
    expect(screen.queryByText('投递概况')).not.toBeInTheDocument();
    expect(screen.queryByTestId('browser-status-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('page-ask-bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /AI 找工作/ })).toBeDisabled();
    // 不调用旧的看板 / 待审接口
    expect(vi.mocked(apiGetJson).mock.calls.some(([p]) => String(p).startsWith('/api/career/board'))).toBe(false);
  });

  it('多维表格：批次带届别、行业、类型标签、截止；默认只看没截止；匹配分展开看证据', async () => {
    mockGet();
    render(<CareerApply />);
    expect(await screen.findByText('我的条件：2027届 · 上海')).toBeInTheDocument();
    expect(tableRows()).toHaveLength(2);
    expect(screen.queryByText('数据分析')).not.toBeInTheDocument();
    expect(screen.getByText('27届 · 正式批')).toBeInTheDocument();
    expect(screen.getByText('互联网')).toBeInTheDocument();
    expect(screen.getByText('央国企')).toBeInTheDocument();
    expect(screen.getByText('12 月 10 日')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '网申' })).toHaveAttribute('href', 'https://example.com/j1');
    fireEvent.click(screen.getByRole('button', { name: '只看没截止' }));
    expect(tableRows()).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('匹配详情 后端工程师'));
    expect(screen.getByText('熟练使用 SQL')).toBeInTheDocument();
    expect(screen.getByText(/电商数据实习：「在 Hive 上写 SQL 做留存分析」/)).toBeInTheDocument();
    expect(screen.getByText('暂无证据')).toBeInTheDocument();
  });

  it('筛选：选项来自已有取值（不是条件编辑器）；搜索只看公司 / 岗位', async () => {
    mockGet();
    render(<CareerApply />);
    await screen.findByText('后端工程师');
    fireEvent.click(screen.getByRole('button', { name: '筛选类型' }));
    const list = screen.getByRole('listbox', { name: '类型' });
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual(['校招2', '实习1', '央国企1']);
    fireEvent.click(within(list).getByRole('option', { name: /实习/ }));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('算法工程师')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '筛选类型' })).toHaveTextContent('类型：实习');
    fireEvent.click(screen.getByRole('button', { name: /清除筛选/ }));
    expect(tableRows()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('搜索岗位'), { target: { value: '丙' } });
    expect(tableRows()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /等于|包含/ })).not.toBeInTheDocument();
  });

  it('页面输入框带上当前筛选（只留非空项）、可见岗位 id 和勾选的岗位', async () => {
    mockGet();
    render(<CareerApply />);
    await screen.findByText('后端工程师');
    fireEvent.change(screen.getByLabelText('搜索岗位'), { target: { value: '丙' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择岗位 后端工程师' }));
    const seen: Array<{ context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.change(screen.getByLabelText('问助理'), { target: { value: '这个适合我吗' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给助理' }));
    off();
    expect(seen[0].context).toEqual({
      surface: 'page:career-dossier:apply',
      refs: { filters: JSON.stringify({ q: '丙', open_only: true }), job_ids: 'j1', selected_job_ids: 'j1' },
    });
  });

  it('auto 模式开关跟加入待投清单放在一起；结果不确定的提交仍要你确认', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerApply />);
    expect(await screen.findByText('点了提交，但没等到成功提示')).toBeInTheDocument();
    expect(screen.getByText('丙公司 · 后端工程师')).toBeInTheDocument();
    expect(screen.getByText('（自学习免确认）')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('auto 模式'));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/apply/settings', { auto_mode: true }));
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
    fireEvent.click(screen.getByRole('button', { name: '已投递' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/applications/a1/stage', { to: 'applied', note: undefined }));
  });

  it('全选当前筛选结果后加入待投清单', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, queued: 2, results: [{ job_id: 'j1', ok: true }, { job_id: 'j2', ok: true }] });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('全选岗位'));
    fireEvent.click(screen.getByRole('button', { name: '加入待投清单（2）' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/prepare', { job_ids: ['j1', 'j2'] }));
    expect(await screen.findByText(/已加入待投清单 2 个/)).toBeInTheDocument();
  });

  it('同步 / 导出是次要的图标按钮；导入岗位收在按钮后面', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, job: { id: 'j3' }, stored: 3 });
    render(<CareerApply />);
    await screen.findByText('后端工程师');
    expect(screen.getByRole('button', { name: '同步校招汇总' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出表格' })).toBeInTheDocument();
    expect(screen.queryByLabelText('导入岗位链接')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入岗位' }));
    fireEvent.change(screen.getByLabelText('导入岗位链接'), { target: { value: 'https://example.com/job/3' } });
    fireEvent.click(screen.getByRole('button', { name: '导入岗位链接' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/import', { url: 'https://example.com/job/3' }));
  });

  it('浏览器状态条：停下等你时才出现，接管动作先经 eventBus 交给 Chat Tab', async () => {
    mockGet();
    render(<CareerApply />);
    await screen.findByText('后端工程师');
    expect(screen.queryByTestId('browser-status-bar')).not.toBeInTheDocument();
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
