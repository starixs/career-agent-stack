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
const actions = [{ id: 'act1', application_id: 'a1', kind: 'submit', payload_json: JSON.stringify({ summary: '提交丙公司网申' }), status: 'pending_review', result_json: null, reviewed_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' }];
const jobs = [
  { id: 'j1', source_platform: 'boss', title: '后端工程师', company_name: '丙公司', location: '上海', salary: '20-30K', score_json: JSON.stringify({ total: 4.2 }), deadline: '2026-10-10', deadline_verified_at: null, url: 'https://example.com/j1' },
  { id: 'j2', source_platform: 'boss', title: '算法工程师', company_name: '丁公司', location: null, salary: null, score_json: null, deadline: null },
];
const applications = [
  { id: 'a1', job_id: 'j1', stage: 'approved', next_action: '填写网申', next_action_due: '2026-10-03', page_url: null },
  { id: 'a2', job_id: 'j2', stage: 'blocked', blocker_reason: '需要验证码', retry_strategy: '明早重试', page_url: null },
];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/board')) return empty ? { ok: true, board: { due: [], blocked: [], funnel: [], pendingReview: 0 } } : { ok: true, board };
    if (path.startsWith('/api/career/actions')) return { ok: true, actions: empty ? [] : actions };
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
    expect(await screen.findByText('岗位池是空的')).toBeInTheDocument();
    expect(screen.getByText('今天没有到期事项')).toBeInTheDocument();
    expect(screen.getByText('没有进行中的浏览器任务')).toBeInTheDocument();
  });

  it('渲染看板三问题、待审核动作与岗位池', async () => {
    mockGet();
    render(<CareerApply />);
    expect(await screen.findByText('今天必须做（1）')).toBeInTheDocument();
    expect(screen.getByText('原因：需要验证码')).toBeInTheDocument();
    expect(screen.getByText('重试策略：明早重试')).toBeInTheDocument();
    expect(screen.getByText('提交丙公司网申')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('20-30K')).toBeInTheDocument();
  });

  it('勾选动作后批准调用 actions/review', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, n: 1 });
    render(<CareerApply />);
    fireEvent.click(await screen.findByLabelText('选择动作 act1'));
    fireEvent.click(screen.getByRole('button', { name: '批准（1）' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/actions/review', { ids: ['act1'], decision: 'approved' }));
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
