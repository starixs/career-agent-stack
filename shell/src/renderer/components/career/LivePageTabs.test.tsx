import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/api/apiFetch', () => ({
  apiGetJson: vi.fn(async () => ({ ok: true, pages: pages.list })),
  apiPostJson: vi.fn(async () => ({ ok: true })),
}));

import { apiPostJson } from '@/api/apiFetch';

import { LivePageTabs, parseLivePages } from './LivePageTabs';

describe('浏览器会话里切换正在投的几家（用户 2026-11-02「只能看到美团这一家」）', () => {
  beforeEach(() => { vi.mocked(apiPostJson).mockClear(); });

  it('只有一家开着页面：不出这一排', async () => {
    pages.list = [{ application_id: 'a1', company: '美团', title: '商业分析', current: true }];
    render(<LivePageTabs />);
    await waitFor(() => expect(screen.queryByTestId('live-page-tabs')).not.toBeInTheDocument());
  });

  it('几家都开着：点一家，画面切到那一家', async () => {
    pages.list = [{ application_id: 'a1', company: '美团', title: '商业分析', current: true }, { application_id: 'a2', company: '斯达半导体', title: '数据分析', current: false }];
    render(<LivePageTabs />);
    fireEvent.click(await screen.findByRole('tab', { name: '斯达半导体' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/view', { application_id: 'a2' }));
    expect(screen.getByRole('tab', { name: '美团' })).toHaveAttribute('aria-selected', 'true');
  });

  it('返回的数据不全就不认', () => {
    expect(parseLivePages({ pages: [{ application_id: 'a1' }, null, { application_id: 'a2', company: '美团' }] })).toEqual([{ application_id: 'a2', company: '美团', title: '', current: false, waiting: null }]);
    expect(parseLivePages(null)).toEqual([]);
  });

  it('在等你的那家带「等你」，点过去就在那家处理（2026-11-03 哪家要接手就在那家接手）', async () => {
    pages.list = [{ application_id: 'a3', company: '中国中车', title: '数据分析工程师', current: false, waiting: 'login' }, { application_id: 'a1', company: '美团', title: '商业分析', current: true, waiting: null }];
    render(<LivePageTabs />);
    const tab = await screen.findByRole('tab', { name: /中国中车/ });
    expect(tab).toHaveTextContent('等你');
    expect(screen.getByRole('tab', { name: '美团' })).not.toHaveTextContent('等你');
  });
});
