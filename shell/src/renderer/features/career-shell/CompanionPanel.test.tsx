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
  { id: 'tailor', label: '定制', status: 'idle', line: '还没改过' },
  { id: 'apply', label: '网申', status: 'idle', line: '还没开始' },
  { id: 'mail', label: '盯邮箱', status: 'idle', line: '还没连邮箱' },
];
let railSnapshot: Record<string, unknown> = {
  stage: 'profile', blocks, waiting: { count: 0, first: null }, receipts: [], learned: [], today: { prepared: 0, sent: 0, waiting: 0 }, pool: { total: 6, fits: 3, conditions: ['运营'] },
};

let onboardingChecklist: Record<string, boolean> = { has_experience: true, has_confirmed_claim: true, has_master_resume: true, has_mail_account: true, has_job: true, has_application: true, has_material: true };
const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => memoryStorage.get(k) ?? null, setItem: (k: string, v: string) => { memoryStorage.set(k, v); } });
let waitingAsks: Array<{ id: string; title: string }> = [];
vi.mock('@/components/career/delivery/useWaitingAsks', () => ({ useWaitingAsks: () => ({ asks: waitingAsks, run: null, error: null, resolve: vi.fn(), snooze: vi.fn() }) }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { floatingBallPetId: null } }) }));
vi.mock('@/floating-ball/petPackLibrary', () => ({ resolveSelectedPetPack: async () => (await import('@/floating-ball/defaultPetPack')).MINO_DEFAULT_PET_PACK }));

import { CompanionPanel, deadlineLabel, openTodoItem } from './CompanionPanel';
import { OPEN_DECK_EVENT } from '@/components/career/delivery/ReturnCard';
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
  it('50 份并行任务各有自己的岗位身份与进度，不被旧任务覆盖', () => {
    for (let i = 0; i < 50; i++) recordProgress({ runId: `r${i}`, phase: 'apply_batch', message: `填写第 ${i} 份`, company: `公司 ${i}`, job_title: `岗位 ${i}`, progress: 0.2 }, i + 1);
    function Probe() { const { runs } = useWorkSurfaces(); return <><div data-testid="count">{runs.length}</div><div data-testid="job">{runs.find(r => r.key === 'r49')?.jobTitle}</div><div data-testid="company">{runs.find(r => r.key === 'r49')?.company}</div></>; }
    render(<Probe />);
    expect(screen.getByTestId('count')).toHaveTextContent('50');
    expect(screen.getByTestId('job')).toHaveTextContent('岗位 49');
    expect(screen.getByTestId('company')).toHaveTextContent('公司 49');
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
    // 名字固定「小芽」，不跟形象包（Mino）走
    expect(screen.getByTestId('companion-name')).toHaveTextContent('小芽');
    expect(screen.queryByText('Mino')).not.toBeInTheDocument();
    expect(screen.queryByText(/陪你第/)).not.toBeInTheDocument();
    expect(screen.getAllByText('在填教育经历').length).toBeGreaterThan(0);
    const mainline = await screen.findByTestId('rail-mainline');
    expect(within(mainline).getAllByRole('listitem').map(li => li.textContent)).toEqual(['说说你', '定方向', '先投一家', '再投一批']);
    expect(mainline).toHaveTextContent('还剩 3 步');
    expect(screen.getByTestId('rail-block-resume')).toHaveTextContent('边聊边写，已经有 1 段经历');
    expect(await screen.findByTestId('rail-resume-draft')).toHaveTextContent('问卷回收 200 多份来自你说的');
    expect(screen.getByTestId('rail-today')).toHaveTextContent('备好 0 · 今天投出 0');
    expect(screen.getByTestId('rail-today')).not.toHaveTextContent('等你');
    // 邮箱没连：一句事实 + 行尾「连上」，去通知中心的连接中心
    const focus: unknown[] = [];
    const off = onEvent('career:focus', p => focus.push(p));
    fireEvent.click(within(screen.getByTestId('rail-block-mail')).getByRole('button', { name: '连上' }));
    off();
    expect(focus).toEqual([{ surface: 'inbox' }]);
    fireEvent.click(screen.getByRole('tab', { name: /待办/ }));
    expect(await screen.findByText('确认两道开放题')).toBeInTheDocument();
    expect(screen.getByText(/剩 \d+ 小时/)).toBeInTheDocument();
  });

  it('头部只有头像、名字、状态一行：「等你」只在等你条上说，右栏不再数', async () => {
    waitingAsks = [{ id: 'a1', title: '东北证券 · 要登录' }, { id: 'a2', title: '杭州城投 · 开放题' }];
    render(<CompanionPanel />);
    await screen.findByTestId('rail-mainline');
    expect(screen.queryByTestId('companion-summary')).not.toBeInTheDocument();
    expect(screen.getByLabelText('伙伴面板')).not.toHaveTextContent('等你');
    waitingAsks = [];
  });

  it('右栏此刻不再列「等你」那一块（唯一落点是等你条）；待办里也不列交接和待审', async () => {
    railSnapshot = { ...railSnapshot, waiting: { count: 1, first: { title: '这一步要你本人来', detail: '东北证券要登录' } } };
    vi.mocked(careerApi.today).mockResolvedValueOnce({
      items: [
        { kind: 'handoff', priority: 0, title: '浏览器要你接手', ref: { type: 'handoff', id: 'h1' } },
        { kind: 'review', priority: 1, title: '网申等你确认', ref: { type: 'action', id: 'act_1' } },
        { kind: 'interview_today', priority: 4, title: '准备星河科技二面', ref: { type: 'interview', id: 'i1' } },
      ],
      waiting: { count: 0, by_stage: [] }, inbox_new: 0, pending_review: 0,
    });
    render(<CompanionPanel />);
    await screen.findByTestId('rail-mainline');
    expect(screen.queryByTestId('rail-waiting')).not.toBeInTheDocument();
    expect(screen.queryByText('这一步要你本人来')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /待办/ }));
    expect(await screen.findByText('准备星河科技二面')).toBeInTheDocument();
    expect(screen.queryByText('浏览器要你接手')).not.toBeInTheDocument();
    expect(screen.queryByText('网申等你确认')).not.toBeInTheDocument();
    railSnapshot = { ...railSnapshot, waiting: { count: 0, first: null } };
  });

  it('数据还没到时此刻不是一片空白', () => {
    vi.mocked(careerApi.rail).mockImplementationOnce(() => new Promise(() => {}));
    render(<CompanionPanel />);
    expect(screen.getByTestId('rail-placeholder')).toHaveTextContent('在准备…');
  });

  it('网申那一行在等你时给「去处理」：要你本人来 → 浏览器现场；其余 → 等你卡组；从不跳岗位库', async () => {
    railSnapshot = { ...railSnapshot, blocks: blocks.map(b => (b.id === 'apply' ? { ...b, status: 'waiting', line: '2 份要你补一下' } : b)) };
    const focus: unknown[] = [];
    const decks: unknown[] = [];
    const nav: unknown[] = [];
    const offs = [onEvent('career:focus', p => focus.push(p)), onEvent(OPEN_DECK_EVENT, p => decks.push(p)), onEvent(CAREER_NAVIGATE_EVENT, p => nav.push(p))];
    const { unmount } = render(<CompanionPanel />);
    fireEvent.click(within(await screen.findByTestId('rail-block-apply')).getByRole('button', { name: '去处理' }));
    expect(decks).toHaveLength(1);
    expect(focus).toEqual([]);
    unmount();
    act(() => recordTakeover({ runId: 'r1', state: 'paused', reason: 'login' }));
    render(<CompanionPanel />);
    fireEvent.click(within(await screen.findByTestId('rail-block-apply')).getByRole('button', { name: '去处理' }));
    offs.forEach(off => off());
    expect(focus).toContainEqual({ surface: 'live_drawer' });
    expect(nav).toEqual([]);
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
    expect(await screen.findByTestId('rail-resume-chip')).toHaveTextContent('简历好了');
    expect(screen.getByTestId('rail-mainline')).not.toHaveTextContent(/最后一步|交给我/);
    expect(screen.queryByTestId('rail-pool')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rail-resume-draft')).not.toBeInTheDocument();
    // 最近的回执提到此刻「刚投出」，完整的在足迹
    // 公司和岗位是两个级别：分开两个元素，不用「·」连成一串
    expect(await screen.findByTestId('rail-recent-receipts')).toHaveTextContent('招商银行财务管培');
    expect(screen.getByTestId('rail-recent-receipts').textContent).not.toContain('·');
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
    const decks: unknown[] = [];
    const offDeck = onEvent(OPEN_DECK_EVENT, p => decks.push(p));
    const navBefore = nav.length;
    openTodoItem({ kind: 'review', priority: 1, title: '网申等你确认', ref: { type: 'action', id: 'act_1' } });
    expect(decks).toHaveLength(1);
    expect(nav).toHaveLength(navBefore);
    offFocus(); offNav(); offDeck();
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
    expect(screen.getByText('浏览器停在要你本人来的一步')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /足迹/ }));
    await waitFor(() => expect(screen.getByText('填写星河科技网申')).toBeInTheDocument());
    expect(screen.queryByText('确认两道开放题')).not.toBeInTheDocument();
  });
});
