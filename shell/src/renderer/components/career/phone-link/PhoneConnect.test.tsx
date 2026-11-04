import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';
import type { PhoneStatus } from '../../../../shared/careerPhone';
import { PhoneConnectCenter } from './PhoneConnectCenter';
import { CareerLiveBridge } from '../CareerLiveBridge';
import type { LiveStreamEvent } from '../types';

const live = vi.hoisted(() => ({ onEvent: (_event: LiveStreamEvent) => {} }));
vi.mock('../focusGuard', () => ({ installFocusTracking: vi.fn(), returnFocusIfStolen: vi.fn() }));
vi.mock('../useGlobalLive', () => ({ useLiveStream: (_frames: boolean, onEvent: (event: LiveStreamEvent) => void) => {
  live.onEvent = onEvent; return { status: 'open', detail: null };
} }));

const base: PhoneStatus = { platform_supported: true, binding: null, state: 'none', pairing: false, latest: null };
const MI10 = { address: 'e0-cc-f8-b6-28-12', name: 'Mi 10', connected: true };

function serve(status: Partial<PhoneStatus>, phones: unknown[] = []) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path === '/api/career/phone') return { ok: true, status: { ...base, ...status }, phones, computer_name: '鑫磊的MacBook Pro' };
    return { ok: true };
  });
}

describe('手机连接', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true, status: { ...base, pairing: true } });
    vi.mocked(apiDelete).mockReset().mockResolvedValue({ ok: true });
  });

  it('没连：点「连接手机」开始配对，弹窗告诉他在手机上点哪台电脑', async () => {
    serve({});
    render(<PhoneConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: '连接手机' }));
    expect(await screen.findByRole('dialog', { name: '连接手机' })).toBeTruthy();
    expect(screen.getByText('鑫磊的MacBook Pro')).toBeTruthy();
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/pair', {}));
  });

  it('关掉还没配上的弹窗：取消等待', async () => {
    serve({});
    render(<PhoneConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: '连接手机' }));
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/pair/cancel', {}));
  });

  it('这台电脑配对过的手机：一键「用 Mi 10」', async () => {
    serve({}, [MI10]);
    render(<PhoneConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: '用 Mi 10' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/bind', { address: MI10.address, name: 'Mi 10' }));
  });

  it('已连接：显示手机名、状态和最近一条验证码', async () => {
    serve({
      binding: { address: MI10.address, name: 'Mi 10', bound_at: '2026-11-03T04:26:00Z' }, state: 'connected',
      latest: { code: '355161', signature: '飞书招聘', sender: '106948060400143', received_at: '2026-11-03T04:27:07Z', seen_at: '2026-11-03T04:27:09Z', body: '…' },
    });
    render(<PhoneConnectCenter />);
    expect(await screen.findByText('Mi 10')).toBeTruthy();
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.getByText('355161')).toBeTruthy();
    expect(screen.getByText('【飞书招聘】')).toBeTruthy();
  });

  it('短信握手未完成：提示解锁确认权限，不把超时断言为主动拒绝', async () => {
    serve({ binding: { address: MI10.address, name: 'Mi 10', bound_at: '' }, state: 'refused' });
    render(<PhoneConnectCenter />);
    expect(await screen.findByText('短信服务未接通')).toBeTruthy();
    expect(screen.getByText(/请解锁手机/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/reconnect', {}));
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('已配对设备先选择直连，不自动打开三步配对流程', async () => {
    serve({}, [MI10]); render(<PhoneConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: '连接手机' }));
    const dialog = await screen.findByRole('dialog', { name: '连接手机' });
    expect(apiPostJson).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '用 Mi 10' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/bind', { address: MI10.address, name: 'Mi 10' }));
    expect(apiPostJson).not.toHaveBeenCalledWith('/api/career/phone/pair', {});
  });

  it('已记住手机离线时保留记忆；修复配对不先解除绑定', async () => {
    const binding = { address: MI10.address, name: 'Mi 10', bound_at: '', last_connected_at: '2026-11-03T04:26:00Z' };
    serve({ binding, state: 'lost' }); const ui = render(<PhoneConnectCenter />);
    expect(await screen.findByText('暂时离线')).toBeTruthy();
    expect(screen.getByText(/已记住此手机/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    ui.unmount(); serve({ binding, state: 'unpaired' }); render(<PhoneConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: '修复配对' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/pair', {}));
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('全局状态事件自动刷新；流重连 snapshot 会补查错过的手机状态', async () => {
    const binding = { address: MI10.address, name: 'Mi 10', bound_at: '' };
    serve({ binding, state: 'connecting' }); render(<><CareerLiveBridge /><PhoneConnectCenter /></>);
    expect(await screen.findByText('连接中')).toBeTruthy();
    serve({ binding, state: 'connected' });
    act(() => live.onEvent({ type: 'career:data-changed', tables: ['phone_link'] }));
    expect(await screen.findByText('已连接')).toBeTruthy();
    serve({ binding, state: 'lost' });
    act(() => live.onEvent({ type: 'snapshot' }));
    expect(await screen.findByText('暂时离线')).toBeTruthy();
  });

  it('授权阶段说明小米要点「是」；离开页面再回来不重启配对', async () => {
    serve({ binding: { address: MI10.address, name: 'Mi 10', bound_at: '' }, state: 'authorizing' });
    const ui = render(<PhoneConnectCenter />);
    expect(await screen.findByText('连接短信服务')).toBeTruthy();
    expect(screen.getByText(/小米点「是」/)).toBeTruthy();
    ui.unmount(); render(<PhoneConnectCenter />);
    expect(await screen.findByText('连接短信服务')).toBeTruthy();
    expect(apiPostJson).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('休眠不被页面重开唤醒；只有明确点重新连接才发起请求', async () => {
    serve({ binding: { address: MI10.address, name: 'Mi 10', bound_at: '', last_connected_at: '2026-11-03T04:26:00Z' }, state: 'paused' });
    const ui = render(<PhoneConnectCenter />);
    expect(await screen.findByText('已休眠')).toBeTruthy();
    expect(screen.getByText(/不再后台扫描/)).toBeTruthy();
    expect(screen.queryByText(/回来会自动重连/)).toBeNull();
    ui.unmount(); render(<PhoneConnectCenter />);
    expect(await screen.findByText('已休眠')).toBeTruthy();
    expect(apiPostJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/reconnect', {}));
  });

  it('不是 Mac：只说暂不支持', async () => {
    serve({ platform_supported: false });
    render(<PhoneConnectCenter />);
    expect(await screen.findByText('暂只支持 Mac 电脑')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '连接手机' })).toBeNull();
  });
});
