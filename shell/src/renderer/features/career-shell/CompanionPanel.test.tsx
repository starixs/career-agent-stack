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
    onboarding: vi.fn(async () => onboardingChecklist),
  },
}));

let onboardingChecklist: Record<string, boolean> = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { floatingBallPetId: null } }) }));
vi.mock('@/floating-ball/petPackLibrary', () => ({ resolveSelectedPetPack: async () => (await import('@/floating-ball/defaultPetPack')).MINO_DEFAULT_PET_PACK }));

import { CompanionPanel, deadlineLabel, openTodoItem } from './CompanionPanel';
import { CAREER_NAVIGATE_EVENT } from './navModel';
import { stashCareerFocus, takeCareerFocus } from './pendingFocus';
import { emitEvent, onEvent } from '@/api/eventBus';
import { CareerLiveDrawer } from '@/components/career/CareerLiveDrawer';

import { recordProgress, recordTakeover, resetWorkSurfaces, settleProgressRuns, useWorkSurfaces } from './workSurfaceStore';

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

  it('a step that only reported its start is settled when the tool returns or the turn ends', () => {
    // resume_export 只发了「正在导出 pdf」，从来不发完成
    recordProgress({ phase: 'resume_export', message: '正在导出 pdf' }, 1);
    settleProgressRuns();
    function Probe() { const { runs } = useWorkSurfaces(); return <div data-testid="active">{runs.filter(r => !r.finished).length}</div>; }
    render(<><CareerLiveDrawer /><Probe /></>);
    expect(screen.getByTestId('active')).toHaveTextContent('0');
    // 再来一次，经由事件（TabProvider 在 tool-result / message-complete 时发）
    act(() => recordProgress({ phase: 'resume_export', message: '正在导出 pdf' }, 2));
    expect(screen.getByTestId('active')).toHaveTextContent('1');
    act(() => emitEvent('career:progress-settled', null));
    expect(screen.getByTestId('active')).toHaveTextContent('0');
  });

  it('reminds once a day about unfinished onboarding steps and starts the guide from the panel', async () => {
    try { window.localStorage.removeItem('career:onboarding-reminder-day'); } catch { /* no storage */ }
    onboardingChecklist = { has_experience: true, has_confirmed_claim: false, has_master_resume: false, has_mail_account: false, has_job: true, has_application: false, has_material: false };
    const navigations: unknown[] = [];
    const off = onEvent(CAREER_NAVIGATE_EVENT, target => navigations.push(target));
    render(<CompanionPanel />);
    expect(await screen.findByText('还有 3 步新手任务没走完，我带你走一遍？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续新手引导' }));
    off();
    expect(navigations).toEqual([{ kind: 'career-today' }]);
    expect(screen.queryByTestId('companion-onboarding-nudge')).not.toBeInTheDocument();
    onboardingChecklist = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };
  });

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

  it('clicking a todo goes where it belongs', async () => {
    const focus: unknown[] = [];
    const nav: unknown[] = [];
    const offFocus = onEvent('career:focus', p => focus.push(p));
    const offNav = onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p));
    render(<CompanionPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /确认两道开放题/ }));
    expect(nav.at(-1)).toEqual({ kind: 'career-today' });
    openTodoItem({ kind: 'interview_today', priority: 1, title: '字节二面', ref: { type: 'application', id: 'app_1' } });
    expect(focus.at(-1)).toEqual({ surface: 'dossier', application_id: 'app_1' });
    openTodoItem({ kind: 'review', priority: 1, title: '网申等你确认', ref: { type: 'action', id: 'act_1' } });
    expect(nav.at(-1)).toEqual({ kind: 'career-dossier', view: 'apply' });
    offFocus(); offNav();
  });

  it('a focus sent before the page mounts is kept for that page once', () => {
    stashCareerFocus({ surface: 'dossier', application_id: 'app_1' });
    expect(takeCareerFocus('inbox')).toBeNull();
    expect(takeCareerFocus('dossier')).toEqual({ surface: 'dossier', application_id: 'app_1' });
    expect(takeCareerFocus('dossier')).toBeNull();
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
