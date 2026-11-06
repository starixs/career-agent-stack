import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

const live = vi.hoisted(() => ({ handler: null as null | ((ev: unknown) => void) }));
vi.mock('./useGlobalLive', () => ({
  useLiveStream: (_frames: boolean, onEvent: (ev: unknown) => void) => { live.handler = onEvent; return { status: 'open', detail: null }; },
  globalBaseUrl: async () => '',
}));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';

import { resetWorkSurfaces, useWorkSurfaces } from '@/features/career-shell/workSurfaceStore';

import { BrowserSessionPanel, CareerLiveDrawer, HANDBACK_TEXT, journeyText, openLiveDrawer } from './CareerLiveDrawer';

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
    vi.mocked(apiGetJson).mockReset();
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

  it('登录之旅里有「这家先跳过」：这一家登不了就先跳过，接着下一家（2026-11-02 腾讯校招只能 QQ / 微信）', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<Harness />);
    act(() => openLiveDrawer());
    await screen.findByTestId('career-live-drawer');
    push(snapshot());
    expect(screen.queryByRole('button', { name: '这家先跳过' })).not.toBeInTheDocument();
    push(snapshot({ journey: { index: 0, total: 4 } }));
    fireEvent.click(await screen.findByRole('button', { name: '这家先跳过' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/asks/current/login-journey', { skip: true }));
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

  it('交还：助理还在等你处理时不再往对话里补话（它自己会接着办）；等待已经结束的，替你说一句，不用回对话打「好了」', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    const sent: Array<{ text?: string }> = [];
    const off = onEvent<{ text?: string }>('career:chat-suggest', p => { sent.push(p); });
    try {
      render(<Harness />);
      act(() => openLiveDrawer());
      await waitFor(() => expect(live.handler).not.toBeNull());
      for (const waitingUser of [true, false]) {
        push(snapshot({ browser: { ...snapshot().browser, control: 'human' } }));
        vi.mocked(apiGetJson).mockResolvedValue({ ok: true, ...snapshot({ waitingUser }) });
        fireEvent.click(await screen.findByRole('button', { name: '交还给小芽' }));
        await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'agent' }));
        await waitFor(() => expect(apiGetJson).toHaveBeenCalledWith('/api/career/live/state'));
        await act(async () => { await Promise.resolve(); });
        expect(sent.map(m => m.text)).toEqual(waitingUser ? [] : [HANDBACK_TEXT]);
        vi.mocked(apiPostJson).mockClear(); vi.mocked(apiGetJson).mockClear();
      }
    } finally { off(); }
  });

  it('登录之旅：状态行写「登录第几 / 共几家」，只有一家时不写', () => {
    expect(journeyText({ index: 1, total: 3 })).toBe('登录第 2 / 3 家');
    expect(journeyText({ index: 0, total: 1 })).toBe('');
    expect(journeyText(null)).toBe('');
  });

  it('页面请求选文件：自动展开浏览器栏，产品内选文件后交回页面', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, count: 1, bytes: 3 });
    render(<Harness />);
    act(() => emitEvent('career:live-filechooser', { id: 'fc1', state: 'open' }));
    await screen.findByTestId('career-live-drawer');
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot({ fileChooser: { id: 'fc1', sessionId: 's', multiple: false, accept: '.pdf', url: 'https://x.com/apply', ts: 1 } }));
    // 画面下面不放文案：只有两个按钮，不把网页给的格式代码贴出来
    expect(await screen.findByRole('button', { name: '选择文件' })).toBeInTheDocument();
    expect(screen.queryByText(/\.pdf|传一个文件/)).not.toBeInTheDocument();
    const input = screen.getByTestId('live-file-input') as HTMLInputElement;
    expect(input.accept).toBe('.pdf');
    fireEvent.change(input, { target: { files: [new File(['abc'], '简历.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/file', { id: 'fc1', files: [{ name: '简历.pdf', mimeType: 'application/pdf', data: 'YWJj' }] }));
    expect(await screen.findByText('已上传 简历.pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('live-file-chooser')).not.toBeInTheDocument();
  });

  it('不再显示真实窗口按钮；下方展示当前任务与真实进度事件', async () => {
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot({ batch: { status: 'running', done: 1, failed: 0, handoffs: 0, queued: 1, currentTitle: '牛客 Agent 开发', message: '正在填写教育经历', phase: 'driving' } }));
    act(() => { emitEvent('career:progress', { runId: 'run1', phase: 'driving', message: '正在填写教育经历', progress: 0.4 }); });
    expect(screen.queryByRole('button', { name: '显示真实窗口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收回真实窗口' })).not.toBeInTheDocument();
    // 在做什么只在画面下面说一处，不重复
    expect(await screen.findByRole('status')).toHaveTextContent('正在填写教育经历');
    expect(screen.getAllByText('正在填写教育经历')).toHaveLength(1);
    expect(screen.queryByText(/批量：/)).not.toBeInTheDocument();
  });

  it('几份一起投：顶上一份一个标签，下面只讲选中那一家；点另一个标签，画面和下面一起换（2026-11-06 上下两处重复、切了不跟）', async () => {
    let current = 'a';
    vi.mocked(apiGetJson).mockImplementation(async (url: string) => (url === '/api/career/live/pages'
      ? { ok: true, pages: [{ application_id: 'a', company: '甲公司', title: 'Agent 开发', current: current === 'a' }, { application_id: 'b', company: '乙公司', title: '大模型开发', current: current === 'b', waiting: 'login' }] }
      : { ok: true }));
    vi.mocked(apiPostJson).mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/career/live/view') current = (body as { application_id: string }).application_id;
      return { ok: true };
    });
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    act(() => {
      emitEvent('career:progress', { runId: 'run_a', phase: 'apply_batch', message: '正在填写 A 的教育经历', company: '甲公司', job_title: 'Agent 开发', application_id: 'a' });
      emitEvent('career:progress', { runId: 'run_b', phase: 'apply_batch', message: '请在浏览器里登录 B', company: '乙公司', job_title: '大模型开发', application_id: 'b' });
    });
    expect(await screen.findAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('正在填写 A 的教育经历');
    expect(screen.queryByText('请在浏览器里登录 B')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /乙公司/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('请在浏览器里登录 B'));
    expect(screen.getByRole('tab', { name: /乙公司/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('正在填写 A 的教育经历')).not.toBeInTheDocument();
  });

  it('每个标签下面是它自己那棵树：界面没收到过事件，也按服务端存着的进度画；切标签树跟着换（2026-11-06「树没有跟着标签走」）', async () => {
    let current = 'a';
    const progressA = { stage: 'open', state: 'working', trail: [{ stage: 'open', kind: 'navigate', count: 1 }, { stage: 'open', kind: 'entry', count: 1 }] };
    const progressB = { stage: 'fill', state: 'working', trail: [{ stage: 'fill', kind: 'page', count: 1 }, { stage: 'fill', kind: 'field', count: 9 }], cells: { total: 20, done: 9, you: 0 } };
    vi.mocked(apiGetJson).mockImplementation(async (url: string) => (url === '/api/career/live/pages'
      ? { ok: true, pages: [
        { application_id: 'a', company: '闪电智联', title: '产品经理', current: current === 'a', waiting: 'user_request', progress: progressA },
        { application_id: 'b', company: '吉利汽车', title: '数据分析岗', current: current === 'b', waiting: null, progress: progressB },
      ] }
      : { ok: true }));
    vi.mocked(apiPostJson).mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/career/live/view') current = (body as { application_id: string }).application_id;
      return { ok: true };
    });
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    const leaves = () => Array.from(screen.getByTestId('live-branch').querySelectorAll('li')).map(li => li.textContent);
    await waitFor(() => expect(leaves()).toEqual(['打开网址', '进申请表', '等你看一眼']));
    fireEvent.click(screen.getByRole('tab', { name: /吉利汽车/ }));
    await waitFor(() => expect(leaves()).toEqual(['看这一页', '填格子9']));
    expect(screen.getByRole('img', { name: '填好 9 格，共 20 格' })).toBeInTheDocument();
    // 标题下面不再有状态、网址那一行
    expect(screen.queryByText(/x\.com|等你处理|正在工作/)).not.toBeInTheDocument();
  });

  it('第一次打开、还没有网申在跑：摆示例（标一次「示例」、不可点、不进读屏），不是黑框加一句话；浏览器一开就整块换掉', async () => {
    render(<Harness />);
    act(() => openLiveDrawer());
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot({ browser: { hasBrowser: false, control: 'none', reason: null, channel: 'chrome', embedded: true, windowRevealed: false } }));
    const sample = await screen.findByTestId('live-sample');
    expect(within(sample).getAllByText('示例')).toHaveLength(1);
    expect(sample.querySelector('[inert]')).not.toBeNull();
    expect(sample.querySelector('[data-testid=live-stage-track]')).not.toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText('浏览器还没有打开')).not.toBeInTheDocument();
    push(snapshot());
    await waitFor(() => expect(screen.queryByTestId('live-sample')).not.toBeInTheDocument());
  });

  it('交接时只说这一家具体要他做什么，不复述按钮含义；主按钮是我来操作', async () => {
    render(<Harness />);
    act(() => emitEvent('career:takeover', { runId: 'run1', state: 'paused', reason: 'captcha', message: '输入手机收到的验证码' }));
    expect(await screen.findByTestId('career-live-drawer')).toBeInTheDocument();
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot());
    expect(screen.queryByText(/这一步要你本人来/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('输入手机收到的验证码');
    expect(screen.getByRole('button', { name: '我来操作' })).toBeInTheDocument();
  });

  it('后台的事只把栏备好、不把他从别的页面拽回对话页；他自己点去看才跳（2026-11-03 连邮箱时被一次次顶回去）', () => {
    const navs: unknown[] = [];
    const off = onEvent('career:navigate', p => { navs.push(p); });
    render(<Harness />);
    act(() => emitEvent('career:takeover', { runId: 'run1', state: 'paused', reason: 'login' }));
    act(() => emitEvent('career:focus', { surface: 'live_drawer', origin: 'assistant' }));
    expect(navs).toEqual([]);
    act(() => emitEvent('career:focus', { surface: 'live_drawer' }));
    act(() => openLiveDrawer());
    expect(navs).toEqual([{ kind: 'chat' }, { kind: 'chat' }]);
    off();
  });
  it('画面框尺寸上报给 Global，框变化时自动跟随（不用手动切换真实窗口）', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, viewport: { width: 1366, height: 900 }, changed: 1 });
    const size = { width: 640, height: 520 };
    const observers: Array<() => void> = [];
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).dataset.testid === 'live-frame-host' ? size.width : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).dataset.testid === 'live-frame-host' ? size.height : 0; } });
    try {
      render(<Harness />);
      act(() => openLiveDrawer());
      await waitFor(() => expect(live.handler).not.toBeNull());
      push(snapshot());
      // px-5 / py-3 在 jsdom 里没有样式，内边距按 0 计；高度扣掉下方地址行
      await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/viewport', { width: 640, height: 448 }));
      const calls = () => vi.mocked(apiPostJson).mock.calls.filter(c => c[0] === '/api/career/live/viewport').length;
      const before = calls();
      // 变化很小：不重复上报
      size.width = 644;
      act(() => observers.forEach(cb => cb()));
      await new Promise(r => setTimeout(r, 320));
      expect(calls()).toBe(before);
      // 切到全屏 / 拖宽：按新尺寸再报
      size.width = 1200; size.height = 800;
      act(() => observers.forEach(cb => cb()));
      await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/viewport', { width: 1200, height: 728 }));
    } finally {
      globalThis.ResizeObserver = OriginalRO;
      if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw);
      if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch);
    }
  });
});
