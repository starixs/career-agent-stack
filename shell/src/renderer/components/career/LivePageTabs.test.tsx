import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProgressRun } from '@/features/career-shell/workSurfaceStore';

import { LivePageTabs, parseLivePages, type LivePage } from './LivePageTabs';

const page = (id: string, company: string, title: string, extra: Partial<LivePage> = {}): LivePage => ({ application_id: id, company, title, current: false, waiting: null, ...extra });
const run = (applicationId: string, extra: Partial<ProgressRun> = {}): ProgressRun => ({ key: `run_${applicationId}`, steps: [{ message: '正在填', phase: 'apply_batch', at: 1 }], progress: null, finished: false, updatedAt: 1, applicationId, ...extra });

describe('网申现场顶上的标签页（2026-11-02「只能看到美团这一家」；2026-11-06 像浏览器标签、三样东西不平铺）', () => {
  it('一份网申一个标签：点哪个切到哪一家；选中的那个有标记', () => {
    const onShow = vi.fn();
    render(<LivePageTabs pages={[page('a1', '美团', '商业分析', { current: true }), page('a2', '斯达半导体', '数据分析')]} runs={[]} onShow={onShow} />);
    fireEvent.click(screen.getByRole('tab', { name: /斯达半导体/ }));
    expect(onShow).toHaveBeenCalledWith('a2');
    expect(screen.getByRole('tab', { name: /美团/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('公司、岗位、状态是三样东西：公司和岗位各占一行，状态是图形，标签里没有「·」连成的一串', () => {
    render(<LivePageTabs pages={[page('a1', '畅游', '【2027届秋招】数据分析与用研', { current: true, waiting: 'login' })]} runs={[]} onShow={() => {}} />);
    const tab = screen.getByRole('tab');
    expect(within(tab).getByText('畅游')).toBeInTheDocument();
    expect(within(tab).getByText('【2027届秋招】数据分析与用研')).toBeInTheDocument();
    expect(tab.textContent).not.toMatch(/·|等你/);
    expect(tab).toHaveAttribute('data-status', 'waiting');
    expect(tab).toHaveAttribute('title', '等你：需要登录');
  });

  it('状态跟着这一家自己走：等他的、小芽在填的、填好等他投出的、投出了的、还在排队的', () => {
    const pages = [page('w', '甲', '岗', { waiting: 'captcha' }), page('f', '乙', '岗'), page('r', '丙', '岗'), page('d', '丁', '岗'), page('q', '戊', '岗')];
    const runs = [run('w'), run('f'), run('r', { finished: true, ready: true }), run('d', { finished: true })];
    render(<LivePageTabs pages={pages} runs={runs} onShow={() => {}} />);
    expect(screen.getAllByRole('tab').map(t => t.getAttribute('data-status'))).toEqual(['waiting', 'filling', 'ready', 'done', 'queued']);
  });

  it('只开着一家也有标签（它是这一页是谁的标识）；一家都没开就不出这一排', () => {
    const { rerender } = render(<LivePageTabs pages={[page('a1', '美团', '商业分析', { current: true })]} runs={[]} onShow={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    rerender(<LivePageTabs pages={[]} runs={[]} onShow={() => {}} />);
    expect(screen.queryByTestId('live-page-tabs')).not.toBeInTheDocument();
  });

  it('返回的数据不全就不认', () => {
    expect(parseLivePages({ pages: [{ application_id: 'a1', company: '美团', title: '商业分析', current: true }, { company: '缺 id' }, null] }))
      .toEqual([{ application_id: 'a1', company: '美团', title: '商业分析', current: true, waiting: null }]);
    expect(parseLivePages(null)).toEqual([]);
  });
});
