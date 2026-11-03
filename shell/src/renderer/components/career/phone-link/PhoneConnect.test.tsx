import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';
import type { PhoneStatus } from '../../../../shared/careerPhone';
import { PhoneConnectCenter } from './PhoneConnectCenter';

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

  it('拒绝了短信权限：告诉他去哪打开，并能重试', async () => {
    serve({ binding: { address: MI10.address, name: 'Mi 10', bound_at: '' }, state: 'refused' });
    render(<PhoneConnectCenter />);
    expect(await screen.findByText(/打开「短信」或「显示通知」后重试/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/phone/bind', { address: MI10.address, name: 'Mi 10' }));
  });

  it('不是 Mac：只说暂不支持', async () => {
    serve({ platform_supported: false });
    render(<PhoneConnectCenter />);
    expect(await screen.findByText('暂只支持 Mac 电脑')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '连接手机' })).toBeNull();
  });
});
