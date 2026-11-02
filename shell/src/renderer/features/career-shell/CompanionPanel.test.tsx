import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    rail: vi.fn(async () => railSnapshot),
    experiences: vi.fn(async () => [
      { id: 'e1', title: '食堂点餐小程序', role: '前端', org: null, claims: [{ id: 'c1', text: '问卷回收 200 多份', created_from: 'interview' }] },
    ]),
    trust: vi.fn(async () => ({ ok: true })),
  },
}));

const blocks = [
  { id: 'resume', label: '写简历', status: 'working', line: '边聊边写，已经有 1 段经历' },
  { id: 'tailor', label: '定制', status: 'idle', line: '定好方向后，按每个岗位改一版' },
  { id: 'apply', label: '网申', status: 'idle', line: '简历和方向好了就开始' },
  { id: 'mail', label: '盯邮箱', status: 'idle', line: '投出去之后，连上邮箱我替你盯回音' },
];
let railSnapshot: Record<string, unknown> = {
  stage: 'profile', blocks, waiting: { count: 0, first: null }, receipts: [], learned: [], today: { prepared: 0, sent: 0, waiting: 0 }, pool: { total: 6, fits: 3, conditions: ['运营'] },
};

let onboardingChecklist: Record<string, boolean> = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { floatingBallPetId: null } }) }));
vi.mock('@/floating-ball/petPackLibrary', () => ({ resolveSelectedPetPack: async () => (await import('@/floating-ball/defaultPetPack')).MINO_DEFAULT_PET_PACK }));

import { CompanionPanel, deadlineLabel, openTodoItem } from './CompanionPanel';
import { CAREER_NAVIGATE_EVENT } from './navModel';
import { stashCareerFocus, takeCareerFocus } from './pendingFocus';
import { emitEvent, onEvent } from '@/api/eventBus';
import { CareerLiveDrawer } from '@/components/career/CareerLiveDrawer';
import { careerApi } from '@/components/career/careerApi';

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

  it('no longer nags about the retired five-step onboarding, even when steps are unfinished', async () => {
    onboardingChecklist = { has_experience: true, has_confirmed_claim: false, has_master_resume: false, has_mail_account: false, has_job: true, has_application: false, has_material: false };
    render(<CompanionPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /待办/ }));
    expect(await screen.findByText('确认两道开放题')).toBeInTheDocument();
    expect(screen.queryByText(/新手任务/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-onboarding-nudge')).not.toBeInTheDocument();
    onboardingChecklist = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };
  });

  it('此刻：主线进度、正在做的几个岗位、今天三个数；建档时简历草稿是主角，每行标来源', async () => {
    act(() => recordProgress({ runId: 'r1', phase: 'apply_run', message: '在填教育经历' }));
    render(<CompanionPanel />);
    expect(screen.getByText('Mino')).toBeInTheDocument();
    expect(screen.getAllByText('在填教育经历').length).toBeGreaterThan(0);
    expect(await screen.findByTestId('rail-mainline')).toHaveTextContent('还剩 4 步');
    expect(screen.getByTestId('rail-block-resume')).toHaveTextContent('边聊边写，已经有 1 段经历');
    expect(await screen.findByTestId('rail-resume-draft')).toHaveTextContent('问卷回收 200 多份来自你说的');
    expect(screen.getByTestId('rail-today')).toHaveTextContent('备好');
    fireEvent.click(screen.getByRole('tab', { name: /待办/ }));
    expect(await screen.findByText('确认两道开放题')).toBeInTheDocument();
    expect(screen.getByText(/剩 \d+ 小时/)).toBeInTheDocument();
  });

  it('网申那一行在等你时给「去处理」，点了打开浏览器现场（对话里不再出浏览器卡）', async () => {
    railSnapshot = { ...railSnapshot, blocks: blocks.map(b => (b.id === 'apply' ? { ...b, status: 'waiting', line: '2 份等你一下' } : b)) };
    const seen: unknown[] = [];
    const off = onEvent('career:focus', p => seen.push(p));
    render(<CompanionPanel />);
    const row = await screen.findByTestId('rail-block-apply');
    fireEvent.click(within(row).getByRole('button', { name: '去处理' }));
    off();
    expect(seen).toContainEqual({ surface: 'live_drawer' });
    railSnapshot = { ...railSnapshot, blocks };
  });

  it('定方向时岗位池是主角：符合的数和条件小签', async () => {
    railSnapshot = { ...railSnapshot, stage: 'direction' };
    render(<CompanionPanel />);
    expect(await screen.findByTestId('rail-pool')).toHaveTextContent('符合的 3 个');
    expect(screen.getByTestId('rail-pool')).toHaveTextContent('运营');
    railSnapshot = { ...railSnapshot, stage: 'profile' };
  });

  it('建档之后简历收成一枚小块；学会了的那一类做通够数时，他盖章「以后同类直接投」', async () => {
    railSnapshot = { ...railSnapshot, stage: 'batch',
      receipts: [{ application_id: 'a1', company: '招商银行', title: '财务管培', at: '2026-11-02T03:00:00.000Z', resume: '小林的简历', filled: 43 }],
      learned: [{ key: 'system:beisen', kind: 'system', label: '北森', state: 'shown', successes: 2, updated_at: '', propose: true }] };
    render(<CompanionPanel />);
    expect(await screen.findByTestId('rail-resume-chip')).toHaveTextContent('简历 · 1 段 ✓');
    expect(screen.queryByTestId('rail-pool')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rail-resume-draft')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /足迹/ }));
    expect(await screen.findByTestId('rail-receipts')).toHaveTextContent('填了 43 格');
    fireEvent.click(screen.getByRole('button', { name: '以后同类直接投' }));
    await waitFor(() => expect(careerApi.trust).toHaveBeenCalledWith('system:beisen', 'delegate'));
    railSnapshot = { ...railSnapshot, stage: 'profile', receipts: [], learned: [] };
  });

  it('clicking a todo goes where it belongs', async () => {
    const focus: unknown[] = [];
    const nav: unknown[] = [];
    const offFocus = onEvent('career:focus', p => focus.push(p));
    const offNav = onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p));
    render(<CompanionPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /待办/ }));
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
