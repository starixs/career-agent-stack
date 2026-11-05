import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';


import { onEvent } from '@/api/eventBus';
import { TabContext, type TabContextValue } from '@/context/TabContext';
import { resetWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { careerApi } from './careerApi';
import { CareerChatCards, reviewDecisionMessage } from './CareerChatCards';
import { ReviewCard, upsertReviewCard } from './CareerReviewCard';
import type { CareerCard } from './types';

const setupStatus = vi.hoisted(() => ({ current: null as null | { llm: { configured: boolean }; search: { configured: boolean } } }));
vi.mock('./CareerKeysPanel', () => ({
  useCareerSetupStatus: () => ({ status: setupStatus.current, reload: () => {} }),
  CareerKeysPanel: () => null,
}));

function renderWithTab(partial: Partial<TabContextValue>) {
  const value = { tabId: 'tab1', agentDir: '/tmp', careerTakeover: null, careerProgress: null, careerCards: [], messages: [], ...partial } as TabContextValue;
  return render(
    <TabContext.Provider value={value}>
      <CareerChatCards />
    </TabContext.Provider>,
  );
}

/**
 * 提交前过目归等你条（规范 §5.1：要你的事不在对话流里插卡），对话里不再出审核卡；
 * 审核卡组件本身仍在（批准 / 拒绝的交接逻辑），这里直接渲染它来测。
 */
function renderReviewCards(cards: CareerCard[], partial: Partial<TabContextValue> = {}) {
  const value = { tabId: 'tab1', agentDir: '/tmp', careerTakeover: null, careerProgress: null, careerCards: cards, messages: [], ...partial } as TabContextValue;
  return render(
    <TabContext.Provider value={value}>
      {cards.map(c => <ReviewCard key={c.id} card={c} onDone={() => partial.setCareerCardState?.(c.id, 'completed')} onDismiss={() => partial.setCareerCardState?.(c.id, 'dismissed')} />)}
    </TabContext.Provider>,
  );
}

describe('CareerChatCards', () => {
  it('在 TabProvider 之外不渲染任何内容', () => {
    const { container } = render(<CareerChatCards />);
    expect(container).toBeEmptyDOMElement();
  });

  const reviewCard = (over: Partial<CareerCard> = {}, data: Record<string, unknown> = {}): CareerCard => ({
    id: 'review:a1,a2', kind: 'review', title: '提交丙公司网申', createdAt: '2026-10-17T00:00:00Z', state: 'pending',
    data: { action_ids: ['a1', 'a2'], kind: 'submit', summary: '提交丙公司网申', ...data }, ...over,
  });

  it('提交前过目、填表缺项不在对话里出卡（归等你条）；一批待投在对话里留一张批次卡', () => {
    renderWithTab({ careerCards: [
      reviewCard(),
      { id: 'apply_gaps:x', kind: 'apply_gaps', title: '还差 1 项', createdAt: '2026-10-17T00:00:00Z', state: 'pending', data: { action_id: 'x', items: [] } },
      { id: 'needs_user:x', kind: 'needs_user', title: '要你填', createdAt: '2026-10-17T00:00:00Z', state: 'completed', data: { action_id: 'x', items: [] } },
    ] });
    expect(screen.queryByTestId('career-review-card')).toBeNull();
    expect(screen.queryByTestId('career-card-apply_gaps')).toBeNull();
    expect(screen.queryByTestId('career-card-collapsed-needs_user')).toBeNull();
  });

  it('待审核卡片：是一张流程卡片，批准调用 respondCareerReview 并折叠', async () => {
    const respond = vi.fn(async () => true);
    const setState = vi.fn();
    renderReviewCards([reviewCard()], { respondCareerReview: respond, setCareerCardState: setState });
    expect(screen.getByTestId('career-review-card')).toHaveTextContent('提交丙公司网申');
    fireEvent.click(screen.getByRole('button', { name: '批准提交' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(['a1', 'a2'], 'approved'));
    await waitFor(() => expect(setState).toHaveBeenCalledWith('review:a1,a2', 'completed'));
  });

  it('提交卡片内嵌审阅清单，按实际数字显示', () => {
    renderReviewCards([reviewCard({ title: '「美团 后端」必填 12/12 已填好并核对过，停在「投递」前' }, {
      review: { rows: [{ label: '姓名', required: true, status: 'ok', value: '{{vault:profile.name}}' }], attention: 0, requiredTotal: 12, requiredFilled: 12 },
    })]);
    const el = screen.getByTestId('career-review-card');
    expect(el).toHaveTextContent('必填 12/12 已填好并核对过');
    expect(el).toHaveTextContent('检查全部通过');
  });

  it('两张审核卡片各自显示，不互相覆盖', () => {
    renderReviewCards([reviewCard(), reviewCard({ id: 'review:b1', title: '提交乙公司网申' }, { action_ids: ['b1'], summary: '提交乙公司网申' })]);
    expect(screen.getAllByTestId('career-review-card')).toHaveLength(2);
  });

  it('提交卡：批准由后台执行、不发话给助理；「先不提交」展开三个选项，「这家不投了」拒绝并标成跳过，也不叫助理问下一步', async () => {
    const reject = vi.spyOn(careerApi, 'reviewActions').mockResolvedValue({});
    const sent: unknown[] = [];
    const off = onEvent('career:chat-suggest', p => { sent.push(p); });
    try {
      const card = reviewCard({ id: 'review:act_1', title: '「美团 AI应用开发工程师」必填 8/8 已填好并核对过' }, { action_ids: ['act_1'], summary: '「美团 AI应用开发工程师」必填 8/8 已填好并核对过' });
      const respond = vi.fn(async () => true);
      const setState = vi.fn();
      const { unmount } = renderReviewCards([card], { respondCareerReview: respond, setCareerCardState: setState });
      fireEvent.click(screen.getByRole('button', { name: '批准提交' }));
      await waitFor(() => expect(respond).toHaveBeenCalledWith(['act_1'], 'approved'));
      unmount();

      renderReviewCards([card], { respondCareerReview: respond, setCareerCardState: setState });
      fireEvent.click(screen.getByRole('button', { name: '先不提交' }));
      const options = screen.getByRole('group', { name: '先不提交，那就' });
      expect(within(options).getAllByRole('button').map(b => b.textContent)).toEqual(['在页面上改', '这家不投了', '晚点再说']);
      fireEvent.click(within(options).getByRole('button', { name: '这家不投了' }));
      await waitFor(() => expect(reject).toHaveBeenCalledWith(['act_1'], 'rejected', { drop: true }));
      await waitFor(() => expect(setState).toHaveBeenCalledWith('review:act_1', 'completed'));
      expect(sent).toEqual([]);
    } finally { off(); reject.mockRestore(); }
  });

  it('reviewDecisionMessage：拒绝让助理先别执行；批准填表 / 提交由后台接手，返回 null 不叫助理', () => {
    const base = { actionIds: ['a1'], summary: '提交丙公司网申' };
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'rejected')?.text).toContain('先别执行');
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'approved')).toBeNull();
    expect(reviewDecisionMessage({ ...base, kind: 'fill_form' }, 'approved')).toBeNull();
  });

  it('浏览器交接不在对话里出卡（现场与等你在右栏，三选一）', () => {
    resetWorkSurfaces();
    renderWithTab({
      careerTakeover: { sessionId: 's1', runId: 'run1', state: 'paused', reason: 'login', url: 'https://example.com' },
      requestCareerTakeover: vi.fn(async () => true),
    });
    expect(screen.queryByTestId('career-browser-card')).not.toBeInTheDocument();
  });

  it('running 状态不显示接管卡片；进度不在对话里出行（只在右栏「正在做」）', () => {
    renderWithTab({
      careerTakeover: { sessionId: 's1', runId: 'run1', state: 'running' },
      careerProgress: { sessionId: 's1', phase: '填表', message: '正在填写第 2 页', progress: 0.4, runId: 'run1' },
      dismissCareerProgress: vi.fn(),
    });
    expect(screen.queryByTestId('career-takeover-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('career-progress-row')).not.toBeInTheDocument();
    expect(screen.queryByText('正在填写第 2 页')).not.toBeInTheDocument();
  });

  it('开场两扇门排在配 Key 卡之前：小芽先开口', async () => {
    setupStatus.current = { llm: { configured: false }, search: { configured: false } };
    const onboarding = vi.spyOn(careerApi, 'onboarding').mockResolvedValue({ has_master_resume: false, has_experience: false } as Awaited<ReturnType<typeof careerApi.onboarding>>);
    try {
      renderWithTab({});
      const starter = await screen.findByTestId('career-starter-card');
      const setupCards = screen.getByTestId('career-setup-cards');
      expect(starter.compareDocumentPosition(setupCards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally { onboarding.mockRestore(); setupStatus.current = null; }
  });

  it('对话开始后（有用户消息）开场两扇门不再留在对话底部', async () => {
    const onboarding = vi.spyOn(careerApi, 'onboarding').mockResolvedValue({ has_master_resume: false, has_experience: false } as Awaited<ReturnType<typeof careerApi.onboarding>>);
    try {
      renderWithTab({ messages: [{ id: 'u1', role: 'user', content: '我是 27 届', timestamp: new Date() }] });
      await waitFor(() => expect(onboarding).toHaveBeenCalled());
      expect(screen.queryByTestId('career-starter-card')).toBeNull();
    } finally { onboarding.mockRestore(); }
  });

  it('upsertReviewCard：后台事件按动作合并成卡片，保留锚点与审阅清单，不覆盖别的动作', () => {
    const anchored: CareerCard = { id: 'review:s1', kind: 'review', title: '旧', createdAt: 't0', toolUseId: 'toolu_a', state: 'completed', data: { action_ids: ['s1'], kind: 'submit', review: { rows: [], attention: 0, requiredTotal: 3, requiredFilled: 3 } } };
    let cards = upsertReviewCard([anchored], { sessionId: 'g', actionIds: ['s1'], kind: 'submit', summary: '提交没成功：网站提示手机号格式不对' });
    cards = upsertReviewCard(cards, { sessionId: 'g', actionIds: ['s2'], kind: 'submit', summary: '「乙」必填 2/2 已填好并核对过' });
    expect(cards.map(c => c.id).sort()).toEqual(['review:s1', 'review:s2']);
    const s1 = cards.find(c => c.id === 'review:s1')!;
    expect(s1).toMatchObject({ toolUseId: 'toolu_a', state: 'pending', title: '提交没成功：网站提示手机号格式不对' });
    expect((s1.data.review as { requiredTotal: number }).requiredTotal).toBe(3);
    expect(cards.find(c => c.id === 'review:s2')!.toolUseId).toBeNull();
  });
});
