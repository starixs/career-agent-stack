import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ResumeSurfacePanel } from '@/features/career-shell/workSurfaces';

import { CareerResumeDrawer, openResumeDrawer } from './CareerResumeDrawer';

/** App mounts the controllers; Chat's right column renders whichever surface is expanded. */
function Harness() {
  const { expanded } = useWorkSurfaces();
  return (
    <>
      <CareerResumeDrawer />
      <CareerLiveDrawer />
      {expanded === 'browser' && <BrowserSessionPanel />}
      {expanded === 'resume' && <ResumeSurfacePanel />}
    </>
  );
}

describe('CareerResumeDrawer', () => {
  beforeEach(() => resetWorkSurfaces());

  it('助理 ui_open(resume_editor) → career:focus 在对话页右栏打开简历并定位到那一版', async () => {
    render(<Harness />);
    expect(screen.queryByTestId('career-surface-panel-resume')).not.toBeInTheDocument();
    act(() => emitEvent('career:focus', { surface: 'resume_editor', id: 'rt_1' }));
    const editor = await screen.findByTestId('resume-editor');
    expect(editor).toHaveAttribute('data-resume', 'rt_1');
    // 工作台三栏需要宽度：默认铺满
    expect(screen.getByTestId('career-surface-panel-resume')).toHaveAttribute('data-fullscreen', 'true');

    act(() => emitEvent('career:focus', { surface: 'resume_editor', id: 'rm_2' }));
    expect(await screen.findByTestId('resume-editor')).toHaveAttribute('data-resume', 'rm_2');
  });

  it('默认铺满，可以收回侧栏；收起后下次打开仍铺满', async () => {
    render(<Harness />);
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('resume-editor');
    expect(screen.getByTestId('career-surface-panel-resume')).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }));
    expect(screen.getByTestId('career-surface-panel-resume')).toHaveAttribute('data-fullscreen', 'false');
    fireEvent.click(screen.getByRole('button', { name: '收起改简历' }));
    expect(screen.queryByTestId('career-surface-panel-resume')).not.toBeInTheDocument();
    act(() => openResumeDrawer('rm_1', { fullscreen: false }));
    expect(await screen.findByTestId('career-surface-panel-resume')).toHaveAttribute('data-fullscreen', 'false');
    act(() => openResumeDrawer('rm_1'));
    expect(await screen.findByTestId('career-surface-panel-resume')).toHaveAttribute('data-fullscreen', 'true');
  });

  it('和浏览器工作面互斥：同一时间只展开一个；ui_open(live) 切到浏览器', async () => {
    render(<Harness />);
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('career-surface-panel-resume');
    act(() => openLiveDrawer());
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('career-surface-panel-resume')).not.toBeInTheDocument();
    act(() => openResumeDrawer('rm_1'));
    await screen.findByTestId('career-surface-panel-resume');
    expect(screen.queryByTestId('career-live-drawer')).not.toBeInTheDocument();
    act(() => emitEvent('career:focus', { surface: 'live_drawer' }));
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('career-surface-panel-resume')).not.toBeInTheDocument();
  });
});
