import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

const live = vi.hoisted(() => ({ handler: null as null | ((ev: unknown) => void) }));
vi.mock('./useGlobalLive', () => ({
  useLiveStream: (_frames: boolean, onEvent: (ev: unknown) => void) => { live.handler = onEvent; return { status: 'open', detail: null }; },
  globalBaseUrl: async () => '',
}));

import { apiPostJson } from '@/api/apiFetch';
import { emitEvent } from '@/api/eventBus';

import { resetWorkSurfaces, useWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { BrowserSessionPanel, CareerLiveDrawer, openLiveDrawer } from './CareerLiveDrawer';

/** App mounts the controller; Chat renders the panel while the browser surface is expanded. */
function Harness() {
  const { expanded } = useWorkSurfaces();
  return <><CareerLiveDrawer />{expanded === 'browser' && <BrowserSessionPanel />}</>;
}

const push = (ev: unknown) => { act(() => { live.handler?.(ev); }); };
const snapshot = (over: Record<string, unknown> = {}) => ({
  type: 'snapshot', ts: 1, productSessionId: 's',
  browser: { hasBrowser: true, control: 'agent', reason: null, url: 'https://x.com/apply', title: '网申', channel: 'chrome', embedded: true, windowRevealed: false },
  batch: null, openHandoffs: 0, fileChooser: null, ...over,
});

describe('CareerLiveDrawer', () => {
  beforeEach(() => {
    vi.mocked(apiPostJson).mockReset();
    live.handler = null;
    resetWorkSurfaces();
  });

  it('默认收起；openLiveDrawer 展开对话页右侧浏览器栏，可切全屏再回到侧栏', async () => {
    render(<Harness />);
    expect(screen.queryByTestId('career-live-drawer')).not.toBeInTheDocument();
    act(() => openLiveDrawer());
    const drawer = await screen.findByTestId('career-live-drawer');
    expect(drawer).toHaveAttribute('data-fullscreen', 'false');
    fireEvent.click(screen.getByRole('button', { name: '全屏' }));
    expect(drawer).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }));
    expect(drawer).toHaveAttribute('data-fullscreen', 'false');
    fireEvent.click(screen.getByRole('button', { name: '收起浏览器' }));
    expect(screen.queryByTestId('career-live-drawer')).not.toBeInTheDocument();
  });

  it('点画面即接管：先切控制权，再把这次点击按帧坐标转发', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    push({ type: 'frame', data: 'QUJD', width: 1000, height: 500, ts: 2 });
    const viewport = await screen.findByRole('application', { name: '浏览器实时画面（点击即接管）' });
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(viewport, { clientX: 100, clientY: 50 });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'human', reason: 'user_request' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/input', { type: 'click', x: 200, y: 100, frame: { width: 1000, height: 500 } }));
    expect(await screen.findByRole('button', { name: '交还给小芽' })).toBeInTheDocument();
  });

  it('页面请求选文件：自动展开浏览器栏，产品内选文件后交回页面', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, count: 1, bytes: 3 });
    render(<Harness />);
    act(() => emitEvent('career:live-filechooser', { id: 'fc1', state: 'open' }));
    await screen.findByTestId('career-live-drawer');
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot({ fileChooser: { id: 'fc1', sessionId: 's', multiple: false, accept: '.pdf', url: 'https://x.com/apply', ts: 1 } }));
    expect(await screen.findByText('页面请求上传文件（.pdf）')).toBeInTheDocument();
    const input = screen.getByTestId('live-file-input') as HTMLInputElement;
    expect(input.accept).toBe('.pdf');
    fireEvent.change(input, { target: { files: [new File(['abc'], '简历.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/file', { id: 'fc1', files: [{ name: '简历.pdf', mimeType: 'application/pdf', data: 'YWJj' }] }));
    expect(await screen.findByText('已上传 简历.pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('live-file-chooser')).not.toBeInTheDocument();
  });

  it('内嵌模式提供「显示真实窗口」逃生口', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, revealed: true });
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    fireEvent.click(await screen.findByRole('button', { name: '显示真实窗口' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/window', { visible: true }));
    expect(await screen.findByRole('button', { name: '收回真实窗口' })).toBeInTheDocument();
  });

  it('交接时显示「这一步要你本人来」，主按钮是控制浏览器', async () => {
    render(<Harness />);
    act(() => emitEvent('career:takeover', { runId: 'run1', state: 'paused', reason: 'captcha', message: '输入手机收到的验证码' }));
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    expect(screen.getByText(/这一步要你本人来/)).toBeInTheDocument();
    expect(screen.getByText('输入手机收到的验证码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '控制浏览器' })).toBeInTheDocument();
  });
});
