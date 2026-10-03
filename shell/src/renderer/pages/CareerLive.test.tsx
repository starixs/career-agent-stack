import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

// 直播流用桩：暴露一个 push() 让测试往页面里灌事件
const live = vi.hoisted(() => ({ handler: null as null | ((ev: unknown) => void), status: 'open' as const }));
vi.mock('@/components/career/useGlobalLive', () => ({
  useLiveStream: (_frames: boolean, onEvent: (ev: unknown) => void) => { live.handler = onEvent; return { status: live.status, detail: null }; },
  globalBaseUrl: async () => '',
}));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import CareerLive, { batchSummaryLine } from './CareerLive';

const push = (ev: unknown) => { live.handler?.(ev); };
const snapshot = { type: 'snapshot', ts: 1, productSessionId: 's', browser: { hasBrowser: true, control: 'agent', reason: null, url: 'https://x.com/apply', title: '网申', channel: 'chrome' }, batch: { status: 'running', updatedAt: '', done: 2, failed: 0, handoffs: 1, queued: 3, todayCount: 2, phase: 'driving', message: '正在填写：B 公司 算法实习生', currentTitle: 'B 公司 算法实习生' }, openHandoffs: 1 };

describe('CareerLive', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset(); vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, openHandoffs: 1 });
    live.handler = null;
  });

  it('渲染快照、批量进度与帧；接管 / 交回调用 Global 现场控制接口', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, control: { control: 'human' } });
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot);
    expect(await screen.findByText('已填好 2 · 失败 0 · 等你处理 1 · 队列 3 · 今日 2')).toBeInTheDocument();
    expect(screen.getByText('正在填写：B 公司 算法实习生')).toBeInTheDocument();
    expect(screen.getByText('助理在操作')).toBeInTheDocument();
    push({ type: 'frame', data: 'QUJD', width: 1280, height: 800, ts: 2 });
    await waitFor(() => expect(screen.getByAltText('浏览器实时画面')).toHaveAttribute('src', 'data:image/jpeg;base64,QUJD'));
    fireEvent.click(screen.getByRole('button', { name: '接管' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'human', reason: 'user_request' }));
    expect(await screen.findByRole('button', { name: '交回，继续' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '交回，继续' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/live/control', { control: 'agent', reason: undefined }));
  });

  it('批量控制：暂停 / 停止 / 开始 调用 batch 命令接口；接管事件显示用户该做什么', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, batch: { ...snapshot.batch, status: 'paused' } });
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push(snapshot);
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/batch/command', { cmd: 'pause' }));
    expect(await screen.findByRole('button', { name: '开始 / 继续' })).toBeInTheDocument();
    push({ type: 'career:takeover', ts: 3, runId: 'run_1', state: 'paused', reason: 'captcha', message: '请拖动滑块完成验证，然后点"交还"继续' });
    expect(await screen.findByRole('status')).toHaveTextContent('请拖动滑块');
    expect(screen.getByText(/等你处理：/)).toBeInTheDocument();
  });

  it('没有浏览器时给出引导文案', async () => {
    render(<CareerLive />);
    await waitFor(() => expect(live.handler).not.toBeNull());
    push({ ...snapshot, browser: { ...snapshot.browser, hasBrowser: false, control: 'none' }, batch: null });
    expect(await screen.findByText(/浏览器还没有打开/)).toBeInTheDocument();
    expect(screen.getByText('还没有批量任务')).toBeInTheDocument();
    expect(batchSummaryLine(null)).toBe('还没有批量任务');
  });
});
