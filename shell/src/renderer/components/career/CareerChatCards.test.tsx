import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { onEvent } from '@/api/eventBus';
import { TabContext, type TabContextValue } from '@/context/TabContext';
import { resetWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { CareerChatCards, reviewDecisionMessage } from './CareerChatCards';

function renderWithTab(partial: Partial<TabContextValue>) {
  const value = { tabId: 'tab1', agentDir: '/tmp', pendingCareerReview: null, careerTakeover: null, careerProgress: null, ...partial } as TabContextValue;
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

  it('待审核卡片：批准调用 respondCareerReview', async () => {
    const respond = vi.fn(async () => true);
    renderWithTab({
      pendingCareerReview: { sessionId: 's1', actionIds: ['a1', 'a2'], kind: 'submit', summary: '提交丙公司网申' },
      respondCareerReview: respond,
    });
    expect(screen.getByTestId('career-review-card')).toHaveTextContent('提交丙公司网申');
    expect(screen.getByText('提交')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(['a1', 'a2'], 'approved'));
  });

  it('交接：批准填表后把决定发给助理，让它接着 apply_run；回传失败就不发', async () => {
    const sent: Array<{ text?: string; mode?: string }> = [];
    const off = onEvent<{ text?: string; mode?: string }>('career:chat-suggest', p => { sent.push(p); });
    try {
      const respond = vi.fn(async () => true);
      const review = { sessionId: 's1', actionIds: ['act_1'], kind: 'fill_form', summary: '为「美团 AI应用开发工程师」填写网申表单' };
      const { unmount } = renderWithTab({ pendingCareerReview: review, respondCareerReview: respond });
      fireEvent.click(screen.getByRole('button', { name: '批准' }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].mode).toBe('send');
      expect(sent[0].text).toContain('批准了');
      expect(sent[0].text).toContain('act_1');
      expect(sent[0].text).toContain('apply_run');
      unmount();

      renderWithTab({ pendingCareerReview: review, respondCareerReview: vi.fn(async () => false) });
      fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回传失败'));
      expect(sent).toHaveLength(1);
    } finally { off(); }
  });

  it('reviewDecisionMessage：拒绝让助理先别执行；提交让助理跟进结果', () => {
    const base = { actionIds: ['a1'], summary: '提交丙公司网申' };
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'rejected')).toContain('先别执行');
    expect(reviewDecisionMessage({ ...base, kind: 'submit' }, 'approved')).toContain('跟进提交结果');
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
    expect(screen.queryByText('运行 run1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /填表/ }));
    expect(screen.getByText('运行 run1')).toBeInTheDocument();
  });
});
