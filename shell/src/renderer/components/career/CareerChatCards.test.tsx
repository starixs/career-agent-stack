import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { onEvent } from '@/api/eventBus';
import { TabContext, type TabContextValue } from '@/context/TabContext';
import { resetWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { CareerChatCards, phaseLabel, reviewDecisionMessage } from './CareerChatCards';
import { upsertReviewCard } from './CareerReviewCard';
import type { CareerCard } from './types';

function renderWithTab(partial: Partial<TabContextValue>) {
  const value = { tabId: 'tab1', agentDir: '/tmp', careerTakeover: null, careerProgress: null, careerCards: [], messages: [], ...partial } as TabContextValue;
  return render(
    <TabContext.Provider value={value}>
      <CareerChatCards />
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

  it('待审核卡片：是一张流程卡片，批准调用 respondCareerReview 并折叠', async () => {
    const respond = vi.fn(async () => true);
    const setState = vi.fn();
    renderWithTab({ careerCards: [reviewCard()], respondCareerReview: respond, setCareerCardState: setState });
    expect(screen.getByTestId('career-review-card')).toHaveTextContent('提交丙公司网申');
    fireEvent.click(screen.getByRole('button', { name: '批准提交' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(['a1', 'a2'], 'approved'));
    await waitFor(() => expect(setState).toHaveBeenCalledWith('review:a1,a2', 'completed'));
  });

  it('提交卡片内嵌审阅清单，按实际数字显示', () => {
    renderWithTab({ careerCards: [reviewCard({ title: '「美团 后端」必填 12/12 已填好并核对过，停在「投递」前' }, {
      review: { rows: [{ label: '姓名', required: true, status: 'ok', value: '{{vault:profile.name}}' }], attention: 0, requiredTotal: 12, requiredFilled: 12 },
    })] });
    const el = screen.getByTestId('career-review-card');
    expect(el).toHaveTextContent('必填 12/12 已填好并核对过');
    expect(el).toHaveTextContent('检查全部通过');
  });

  it('两张审核卡片各自显示，不互相覆盖', () => {
    renderWithTab({ careerCards: [reviewCard(), reviewCard({ id: 'review:b1', title: '提交乙公司网申' }, { action_ids: ['b1'], summary: '提交乙公司网申' })] });
    expect(screen.getAllByTestId('career-review-card')).toHaveLength(2);
  });

  it('交接：批准后发给助理的是人话，动作 id 与工具名只在隐藏上下文里；回传失败就不发', async () => {
    const sent: Array<{ text?: string; mode?: string; context?: { refs?: Record<string, string>; note?: string } }> = [];
    const off = onEvent<(typeof sent)[number]>('career:chat-suggest', p => { sent.push(p); });
    try {
      const card = reviewCard({ id: 'review:act_1', title: '「美团 AI应用开发工程师」必填 8/8 已填好并核对过' }, { action_ids: ['act_1'], summary: '「美团 AI应用开发工程师」必填 8/8 已填好并核对过' });
      const { unmount } = renderWithTab({ careerCards: [card], respondCareerReview: vi.fn(async () => true), setCareerCardState: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: '批准提交' }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].mode).toBe('send');
      expect(sent[0].text).toContain('批准提交');
      expect(sent[0].text).not.toMatch(/act_1|apply_|动作/);
      expect(sent[0].context?.refs).toEqual({ action_id: 'act_1' });
      unmount();

      renderWithTab({ careerCards: [card], respondCareerReview: vi.fn(async () => false), setCareerCardState: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: '先不提交' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('没能保存'));
      expect(sent).toHaveLength(1);
    } finally { off(); }
  });

  it('reviewDecisionMessage：拒绝让助理先别执行；提交让助理跟进结果；填表的工具名只在隐藏 note 里', () => {
    const base = { actionIds: ['a1'], summary: '提交丙公司网申' };
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'rejected').text).toContain('先别执行');
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'approved').text).toContain('跟进提交结果');
    const fill = reviewDecisionMessage({ ...base, kind: 'fill_form' }, 'approved');
    expect(fill.text).not.toContain('apply_run');
    expect(fill.context.note).toContain('apply_run');
  });

  it('浏览器交接：工具卡说明停在哪一步，「去处理」展开右侧浏览器栏', async () => {
    resetWorkSurfaces();
    renderWithTab({
      careerTakeover: { sessionId: 's1', runId: 'run1', state: 'paused', reason: 'login', url: 'https://example.com' },
      requestCareerTakeover: vi.fn(async () => true),
    });
    const card = screen.getByTestId('career-browser-card');
    expect(card).toHaveTextContent('停在这一步「需要登录」');
    const events: unknown[] = [];
    const off = onEvent('career:live-drawer', p => events.push(p));
    fireEvent.click(screen.getByRole('button', { name: '去处理' }));
    off();
    await waitFor(() => expect(events).toEqual([{ open: true }]));
  });

  it('running 状态不显示接管卡片；进度行可折叠', () => {
    renderWithTab({
      careerTakeover: { sessionId: 's1', runId: 'run1', state: 'running' },
      careerProgress: { sessionId: 's1', phase: '填表', message: '正在填写第 2 页', progress: 0.4, runId: 'run1' },
      dismissCareerProgress: vi.fn(),
    });
    expect(screen.queryByTestId('career-takeover-card')).not.toBeInTheDocument();
    const row = screen.getByTestId('career-progress-row');
    expect(row).toHaveTextContent('填表');
    expect(row).toHaveTextContent('40%');
    fireEvent.click(screen.getByRole('button', { name: /填表/ }));
    // 展开后也不露运行 / 任务 id
    expect(row).not.toHaveTextContent('run1');
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

  it('进度行不显示内部 phase 名（工具名 / 技能 id）', () => {
    expect(phaseLabel('fill_form')).toBe('填表');
    expect(phaseLabel('apply_run')).toBe('填表');
    expect(phaseLabel('company-research')).toBeNull();
    expect(phaseLabel('填表')).toBe('填表');
  });
});
