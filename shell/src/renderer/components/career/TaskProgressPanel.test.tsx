import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/api/apiFetch', () => ({
  apiGetJson: vi.fn(async () => ({ ok: true, pages: pages.list })),
  apiPostJson: vi.fn(async () => ({ ok: true })),
}));

import { recordProgress, resetWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { TaskProgressPanel } from './TaskProgressPanel';

const didi = { application_id: 'a_didi', company: '滴滴', title: '数据分析师' };
const tencent = { application_id: 'a_tx', company: '腾讯', title: '算法' };

describe('浏览器会话下方的状态区（2026-11-05 切到腾讯下面还是滴滴；滴滴投完了还卡在进行中）', () => {
  beforeEach(() => { resetWorkSurfaces(); });

  it('画面切到哪一家，状态区就是哪一家；那一家还没进展就说在排队，不拿别家顶上', async () => {
    pages.list = [{ ...didi, current: false }, { ...tencent, current: true }];
    act(() => { recordProgress({ runId: 'run_1', phase: 'apply_batch', message: '已填完', company: '滴滴', job_title: '数据分析师', application_id: 'a_didi' }); });
    render(<TaskProgressPanel batch={{ status: 'paused', done: 1, failed: 0, handoffs: 0, queued: 1, currentTitle: '滴滴 · 数据分析师', message: '「滴滴」等你批准提交' } as never} />);
    expect(await screen.findByText('腾讯 · 算法')).toBeInTheDocument();
    expect(screen.getByText('排队中')).toBeInTheDocument();
    expect(screen.getByText('这一家还在排队，轮到它就开始填')).toBeInTheDocument();
  });

  it('填好了停在提交前：说「等你投出」，不说「已完成」也不说整批的「已暂停」', async () => {
    pages.list = [{ ...didi, current: true }];
    act(() => { recordProgress({ runId: 'run_fill', phase: 'apply_batch_ready', message: '必填 12/12 已填好并核对过，停在「预览并提交」前，等你过目后投出', company: '滴滴', job_title: '数据分析师', application_id: 'a_didi' }); });
    render(<TaskProgressPanel batch={{ status: 'paused', done: 1, failed: 0, handoffs: 0, queued: 0, message: '' } as never} />);
    expect(await screen.findByText('等你投出')).toBeInTheDocument();
    expect(screen.queryByText('已暂停')).not.toBeInTheDocument();
  });

  it('提交这一步并进同一家那一条：投出后收尾成「已完成」，不再多出一条「网申任务 · 进行中」', async () => {
    pages.list = [{ ...didi, current: true }];
    act(() => {
      recordProgress({ runId: 'run_fill', phase: 'apply_batch', message: '已填完，停在「预览并提交」前', company: '滴滴', job_title: '数据分析师', application_id: 'a_didi' });
      recordProgress({ runId: 'run_fill', phase: 'submit', message: '正在提交网申', application_id: 'a_didi' });
      recordProgress({ runId: 'run_fill', phase: 'submit_done', message: '已投出', application_id: 'a_didi', progress: 1 });
    });
    render(<TaskProgressPanel batch={{ status: 'paused', done: 1, failed: 0, handoffs: 0, queued: 0, message: '' } as never} />);
    await waitFor(() => expect(screen.getByText('已完成')).toBeInTheDocument());
    expect(screen.getByText('滴滴 · 数据分析师')).toBeInTheDocument();
    expect(screen.queryByText('网申任务')).not.toBeInTheDocument();
    expect(screen.queryByText('已暂停')).not.toBeInTheDocument();
  });
});
