import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerResume', () => ({
  default: ({ initialResumeId, compact }: { initialResumeId?: string | null; compact?: boolean }) => (
    <div data-testid="resume-editor" data-resume={initialResumeId ?? ''} data-compact={compact ? 'true' : 'false'} />
  ),
}));
vi.mock('./useGlobalLive', () => ({ useLiveStream: () => ({ status: 'open', detail: null }), globalBaseUrl: async () => '' }));

import { emitEvent } from '@/api/eventBus';

import { resetWorkSurfaces, useWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { BrowserSessionPanel, CareerLiveDrawer, openLiveDrawer } from './CareerLiveDrawer';

function LiveHarness() {
  const { expanded } = useWorkSurfaces();
  return <><CareerLiveDrawer />{expanded === 'browser' && <BrowserSessionPanel />}</>;
}
import { CareerResumeDrawer, openResumeDrawer } from './CareerResumeDrawer';

describe('CareerResumeDrawer', () => {
  it('助理 ui_open(resume_editor) → career:focus 打开聊天旁编辑器并定位到那一版', async () => {
    render(<CareerResumeDrawer />);
    expect(screen.queryByTestId('career-resume-drawer')).not.toBeInTheDocument();
    act(() => emitEvent('career:focus', { surface: 'resume_editor', id: 'rt_1' }));
    const editor = await screen.findByTestId('resume-editor');
    expect(editor).toHaveAttribute('data-resume', 'rt_1');
    // 工作台三栏需要宽度：默认铺满
    expect(screen.getByTestId('career-resume-drawer')).toHaveAttribute('data-fullscreen', 'true');

    act(() => emitEvent('career:focus', { surface: 'resume_editor', id: 'rm_2' }));
    expect(await screen.findByTestId('resume-editor')).toHaveAttribute('data-resume', 'rm_2');
  });

  it('默认铺满，可以收回侧栏；收起后下次打开仍铺满', async () => {
    render(<CareerResumeDrawer />);
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('resume-editor');
    expect(screen.getByTestId('career-resume-drawer')).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }));
    expect(screen.getByTestId('career-resume-drawer')).toHaveAttribute('data-fullscreen', 'false');
    fireEvent.click(screen.getByRole('button', { name: '收起简历编辑' }));
    expect(screen.queryByTestId('career-resume-drawer')).not.toBeInTheDocument();
    act(() => openResumeDrawer('rm_1', { fullscreen: false }));
    expect(await screen.findByTestId('career-resume-drawer')).toHaveAttribute('data-fullscreen', 'false');
    act(() => openResumeDrawer('rm_1'));
    expect(await screen.findByTestId('career-resume-drawer')).toHaveAttribute('data-fullscreen', 'true');
  });

  it('和浏览器现场抽屉互斥：一个打开另一个收起；ui_open(live) 打开现场', async () => {
    resetWorkSurfaces();
    render(<><CareerResumeDrawer /><LiveHarness /></>);
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('career-resume-drawer');
    act(() => openLiveDrawer());
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('career-resume-drawer')).not.toBeInTheDocument();
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('career-resume-drawer');
    expect(screen.queryByTestId('career-live-drawer')).not.toBeInTheDocument();
    act(() => emitEvent('career:focus', { surface: 'live_drawer' }));
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('career-resume-drawer')).not.toBeInTheDocument();
  });
});
