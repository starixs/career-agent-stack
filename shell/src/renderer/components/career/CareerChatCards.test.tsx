import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TabContext, type TabContextValue } from '@/context/TabContext';

import { CareerChatCards } from './CareerChatCards';

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

  it('浏览器需要你：paused 显示原因，接管调用 requestCareerTakeover', async () => {
    const takeover = vi.fn(async () => true);
    renderWithTab({
      careerTakeover: { sessionId: 's1', runId: 'run1', state: 'paused', reason: 'login', url: 'https://example.com' },
      requestCareerTakeover: takeover,
    });
    expect(screen.getByTestId('career-takeover-card')).toHaveTextContent('原因：需要登录');
    expect(screen.getByRole('button', { name: '查看现场' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接管' }));
    await waitFor(() => expect(takeover).toHaveBeenCalledWith('run1', 'take'));
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
