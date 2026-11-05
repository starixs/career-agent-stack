/**
 * 框选一批、确认投出（立场 9）：一条确认里说清几家开始、跳过原因、用哪份简历；点一次就开始，下一步指向等你条。
 * 服务端同一条链路见 server/career/chain-batch-slice.unit.test.ts。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';

import { ApplyConfirm, skippedText, startedText } from './JobBoardApply';

const PLAN = {
  ready: ['j1', 'j2', 'j3', 'j4', 'j5'], targets: 2,
  skipped: [{ job_id: 'j6', reason: '已经投过' }, { job_id: 'j7', reason: '没有网申链接' }],
  needs_resume: ['j3', 'j4', 'j5'], resumes: [{ id: 'r_ai', name: 'AI 方向' }, { id: 'r_gen', name: '通用版' }],
};

describe('ApplyConfirm', () => {
  beforeEach(() => { vi.mocked(apiPostJson).mockReset(); });

  it('一条说清：5 家开始、标星 2 家先给你看、跳过的原因；两份主简历预选最近的；点一次就开始，提示去等你条', async () => {
    vi.mocked(apiPostJson).mockImplementation(async (url: string) => (url.endsWith('/jobs/plan')
      ? { ok: true, plan: PLAN }
      : { ok: true, started: ['a1', 'a2', 'a3', 'a4', 'a5'], skipped: [] }));
    const onStarted = vi.fn();
    render(<ApplyConfirm jobIds={['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7']} onStarted={onStarted} onCancel={() => {}} />);
    expect(await screen.findByText(/投 5 家：填到提交前停下，标星的 2 家填好后先给你看/)).toBeInTheDocument();
    expect(screen.getByText('跳过 已经投过 1 · 没有网申链接 1')).toBeInTheDocument();
    expect(screen.getByText(/3 家没有定制版/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始投 5 家' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/jobs/apply', { job_ids: PLAN.ready, resume_id: 'r_ai' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.stringContaining('「等你」')));
    expect(onStarted.mock.calls[0][0]).toContain('跳过：已经投过 1 · 没有网申链接 1');
  });

  it('只有一份简历时不问；一家都不能投时按钮灰着', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, plan: { ready: [], targets: 0, skipped: [{ job_id: 'j6', reason: '已经投过' }], needs_resume: [], resumes: [] } });
    render(<ApplyConfirm jobIds={['j6']} onStarted={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText('这一批都不能投')).toBeInTheDocument();
    expect(screen.queryByText(/没有定制版/)).toBeNull();
    expect(screen.getByRole('button', { name: /开始投/ })).toBeDisabled();
  });

  it('跳过里有「已在投」：给「看进展」，点了打开网申进展页', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, plan: { ready: ['j1'], targets: 0, skipped: [{ job_id: 'j6', reason: '已在投' }], needs_resume: [], resumes: [] } });
    const nav: unknown[] = [];
    const off = onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p));
    render(<ApplyConfirm jobIds={['j1', 'j6']} onStarted={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '看进展' }));
    expect(nav).toEqual([{ kind: 'career-live' }]);
    off();
  });

  it('跳过里没有「已在投」：不出「看进展」', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, plan: PLAN });
    render(<ApplyConfirm jobIds={PLAN.ready} onStarted={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole('button', { name: '开始投 5 家' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '看进展' })).toBeNull();
  });

  it('文字：同一原因合在一起数；开始后指向等你条', () => {
    expect(skippedText([{ job_id: 'a', reason: '已在投' }, { job_id: 'b', reason: '已在投' }])).toBe('已在投 2');
    expect(startedText(3, [])).toBe('已开始投 3 家，在后台填到提交前；要你的事会出现在下面的「等你」里。');
  });
});
