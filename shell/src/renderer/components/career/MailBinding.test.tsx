import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./useGlobalLive', () => ({ useLiveStream: () => ({ status: 'open', detail: null }), globalBaseUrl: async () => '' }));

import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';

import { BindMailForm, MailConnectDialog, MAIL_OPTIONS } from './MailBinding';
import type { MailConnectSession } from './types';

const session = (over: Partial<MailConnectSession>): MailConnectSession => ({
  id: 'c1', provider: 'qq', status: 'login', hint: '用手机 QQ 或微信扫码登录 QQ 邮箱', address: null, account_id: null, summary: null, error: null,
  started_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z', ...over,
});

beforeEach(() => { vi.mocked(apiGetJson).mockReset(); vi.mocked(apiPostJson).mockReset(); vi.mocked(apiDelete).mockReset(); });

describe('BindMailForm', () => {
  it('先选邮箱：能一键连接的打开连接弹窗，Outlook / 其他邮箱展开手动表单', () => {
    render(<BindMailForm presets={{}} onBound={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /邮箱|Gmail|Outlook/ }).length).toBeGreaterThanOrEqual(MAIL_OPTIONS.length);
    fireEvent.click(screen.getByRole('button', { name: /Outlook/ }));
    expect(screen.getByLabelText('授权码')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /QQ 邮箱/ }));
    expect(screen.getByRole('dialog', { name: '连接 QQ 邮箱' })).toBeInTheDocument();
  });
});

describe('MailConnectDialog', () => {
  const qq = MAIL_OPTIONS.find(o => o.provider === 'qq')!;

  it('连接 → 显示扫码提示和实时画面 → 自动读到授权码绑定 → 完成', async () => {
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, session: session({}) });
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, session: session({ status: 'done', address: 'me@qq.com', account_id: 'acc1', summary: '拉到 3 封，其中 1 封与求职相关', hint: '已连接 me@qq.com' }) });
    const onBound = vi.fn();
    render(<MailConnectDialog option={qq} onClose={vi.fn()} onManual={vi.fn()} onBound={onBound} pollMs={5} />);
    const dialog = screen.getByRole('dialog', { name: '连接 QQ 邮箱' });
    fireEvent.click(within(dialog).getByRole('button', { name: '连接' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/connect', { provider: 'qq', address: undefined }));
    expect(await within(dialog).findByText('用手机 QQ 或微信扫码登录 QQ 邮箱')).toBeInTheDocument();
    expect(within(dialog).getByText('正在打开官方页面…')).toBeInTheDocument();
    expect(await within(dialog).findByText('已连接 me@qq.com')).toBeInTheDocument();
    expect(apiGetJson).toHaveBeenCalledWith('/api/career/mail/connect/c1');
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));
    expect(onBound).toHaveBeenCalledWith('已连接 me@qq.com，拉到 3 封，其中 1 封与求职相关');
  });

  it('页面上没认出地址：让用户补一个；关掉弹窗时取消连接', async () => {
    vi.mocked(apiPostJson).mockImplementation(async (path: string) => (path.endsWith('/address')
      ? { ok: true, session: session({ status: 'verifying', hint: '正在验证', address: 'me@qq.com' }) }
      : { ok: true, session: session({ status: 'need_address', hint: '读到授权码了，填一下邮箱地址' }) }));
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, session: session({ status: 'verifying', hint: '正在验证', address: 'me@qq.com' }) });
    vi.mocked(apiDelete).mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<MailConnectDialog option={qq} onClose={onClose} onManual={vi.fn()} onBound={vi.fn()} pollMs={10_000} />);
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    fireEvent.change(await screen.findByLabelText('邮箱地址'), { target: { value: 'me@qq.com' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/connect/c1/address', { address: 'me@qq.com' }));
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/career/mail/connect/c1'));
  });
});
