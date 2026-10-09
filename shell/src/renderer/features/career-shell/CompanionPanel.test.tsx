import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/career/careerApi', () => ({
  careerApi: {
    today: vi.fn(async () => ({
      items: [
        { kind: 'deadline', priority: 1, title: '确认两道开放题', detail: '提交前要你看一眼', due_at: new Date(Date.now() + 5 * 3_600_000).toISOString(), ref: { type: 'deadline', id: 'd1' } },
        { kind: 'interview_today', priority: 4, title: '准备星河科技二面', ref: { type: 'interview', id: 'i1' } },
      ],
      waiting: { count: 0, by_stage: [] }, inbox_new: 0, pending_review: 0,
    })),
    activity: vi.fn(async () => [
      { id: 'task:t1', at: '2026-10-09T02:40:00.000Z', kind: 'task', status: 'running', title: '填写星河科技网申', detail: '18 项已填' },
    ]),
  },
}));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { floatingBallPetId: null } }) }));
vi.mock('@/floating-ball/petPackLibrary', () => ({ resolveSelectedPetPack: async () => (await import('@/floating-ball/defaultPetPack')).MINO_DEFAULT_PET_PACK }));

import { CompanionPanel, deadlineLabel } from './CompanionPanel';
import { recordProgress, recordTakeover, resetWorkSurfaces, useWorkSurfaces } from './workSurfaceStore';

describe('deadlineLabel', () => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  it('maps remaining time to the §6.2 urgency tiers', () => {
    expect(deadlineLabel('2026-10-08T23:00:00.000Z', now)).toEqual({ text: '已逾期', tone: 'danger' });
    expect(deadlineLabel('2026-10-09T05:00:00.000Z', now)).toEqual({ text: '剩 5 小时', tone: 'danger' });
    expect(deadlineLabel('2026-10-11T00:00:00.000Z', now)).toEqual({ text: '剩 2 天', tone: 'warning' });
    expect(deadlineLabel('2026-10-20T00:00:00.000Z', now)?.tone).toBe('muted');
    expect(deadlineLabel(null, now)).toBeNull();
  });
});

describe('workSurfaceStore progress', () => {
  beforeEach(() => resetWorkSurfaces());
  it('folds progress events into runs and marks a run finished', () => {
    recordProgress({ runId: 'r1', phase: 'apply_run', message: '打开网申页' }, 1);
    recordProgress({ runId: 'r1', phase: 'apply_run', message: '打开网申页' }, 2);
    recordProgress({ runId: 'r1', phase: 'apply_run', message: '在填教育经历', progress: 0.4 }, 3);
    function Probe() {
      const run = useWorkSurfaces().runs[0];
      return <div data-testid="run" data-finished={String(run?.finished)}>{run?.steps.map(step => step.message).join('|')}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId('run')).toHaveTextContent('打开网申页|在填教育经历');
    expect(screen.getByTestId('run')).toHaveAttribute('data-finished', 'false');
    act(() => recordProgress({ runId: 'r1', phase: 'apply_run:done', message: '填完了', progress: 1 }, 4));
    expect(screen.getByTestId('run')).toHaveAttribute('data-finished', 'true');
  });
});

describe('CompanionPanel', () => {
  beforeEach(() => resetWorkSurfaces());

  it('shows the pet, what it is doing, the next todos and today trail from real data', async () => {
    act(() => recordProgress({ runId: 'r1', phase: 'apply_run', message: '在填教育经历' }));
    render(<CompanionPanel />);
    expect(screen.getByText('Mino')).toBeInTheDocument();
    expect(screen.getAllByText('在填教育经历').length).toBeGreaterThan(0);
    expect(await screen.findByText('确认两道开放题')).toBeInTheDocument();
    expect(screen.getByText(/剩 \d+ 小时/)).toBeInTheDocument();
    expect(await screen.findByText('填写星河科技网申')).toBeInTheDocument();
    expect(screen.getByText('今天 2 件事，1 件急')).toBeInTheDocument();
  });

  it('switches to the waiting state on a browser handoff and filters tabs', async () => {
    act(() => recordTakeover({ runId: 'r1', state: 'paused', reason: 'captcha' }));
    render(<CompanionPanel />);
    expect(screen.getByText('等你处理一下')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /足迹/ }));
    await waitFor(() => expect(screen.getByText('填写星河科技网申')).toBeInTheDocument());
    expect(screen.queryByText('确认两道开放题')).not.toBeInTheDocument();
  });
});
