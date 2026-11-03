import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/utils/openExternal', () => ({ openExternal: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson } from '@/api/apiFetch';
import { openExternal } from '@/utils/openExternal';
import type { MailAccount, MailConnector } from '../types';
import { MailConnectCenter } from './MailConnectCenter';

const field = (key: 'email' | 'authCode') => key === 'email'
  ? { key, type: 'email' as const, label: '邮箱地址', placeholder: 'you@qq.com' }
  : { key, type: 'secret' as const, label: '授权码', placeholder: '16 位字母', helper: '16 位字母，不是 QQ 密码', length: 16 };
const connector = (id: MailConnector['id'], name: string): MailConnector => ({
  id, name, auth_type: 'credential_form', capabilities: ['receive', 'send'], open_url: `https://mail.example/${id}`, open_label: `打开 ${name}`, help_url: null,
  guide: [{ title: `打开 ${name} 网页版`, text: '在浏览器里打开' }, { title: '生成授权码', text: '按路径找', path: ['设置', '账号与安全', '生成授权码'] }],
  verify_note: '要用微信扫码验证', fields: [field('email'), field('authCode')],
});
const connectors = [connector('qq', 'QQ 邮箱'), connector('163', '163 邮箱'), connector('126', '126 邮箱'), connector('gmail', 'Gmail')];
const account = (over: Partial<MailAccount> = {}): MailAccount => ({
  id: 'm1', provider: 'qq', address: 'me@qq.com', display_name: null, imap_host: 'imap.qq.com', imap_port: 993, smtp_host: 'smtp.qq.com', smtp_port: 465,
  status: 'ok', last_sync_at: null, last_uid: 0, last_error: null, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z',
  connection: { state: 'active', health: 'healthy' }, ...over,
});

function mockServer(accounts: MailAccount[], applyAddress: { address: string; connector_id: string | null } | null = null) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path === '/api/career/mail/connectors') return { ok: true, connectors, accounts, apply_address: applyAddress };
    if (path.endsWith('/detail')) return { ok: true, account: accounts[0], usage: { days: 7, by_op: { import: { ok: 1, failed: 0 }, send: { ok: 2, failed: 1 } } }, audit: [{ id: 'a1', actor: 'agent', operation: 'send', status: 'ok', detail: { to: ['hr@x.com'], subject_preview: '应聘产品' }, latency_ms: 300, created_at: new Date().toISOString() }] };
    return { ok: true };
  });
}

const dialog = () => screen.getByRole('dialog');

describe('邮箱连接中心', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiDelete).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(openExternal).mockReset();
  });

  it('没连的邮箱：说明 → 引导（在浏览器打开官方页、照路径拿授权码）→ 填表', async () => {
    mockServer([]);
    render(<MailConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /QQ 邮箱/ }));
    expect(within(dialog()).getByText(/只存在这台电脑上/)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: '开始连接' }));
    expect(within(dialog()).getByText('账号与安全')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: /打开 QQ 邮箱/ }));
    expect(openExternal).toHaveBeenCalledWith('https://mail.example/qq');
    fireEvent.click(within(dialog()).getByRole('button', { name: '我已获取授权码，下一步' }));
    expect(within(dialog()).getByLabelText('邮箱地址')).toBeInTheDocument();
  });

  it('和投递打通：网申填的是 QQ 邮箱，就在 QQ 那一格写出来，填表时预填它；连上的是别的邮箱如实说一句', async () => {
    mockServer([], { address: 'apply@qq.com', connector_id: 'qq' });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { ok: true, account: account({ address: 'other@qq.com' }), smtp_ok: true, apply_address_mismatch: 'apply@qq.com' } });
    render(<MailConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /网申填的是 apply@qq.com/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '开始连接' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '我已获取授权码，下一步' }));
    const email = within(dialog()).getByLabelText('邮箱地址') as HTMLInputElement;
    expect(email.value).toBe('apply@qq.com');
    fireEvent.change(email, { target: { value: 'other@qq.com' } });
    fireEvent.change(within(dialog()).getByLabelText('授权码'), { target: { value: 'abcdefghijklmnop' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    expect(await within(dialog()).findByText(/网申填的是 apply@qq.com，招聘方的回音会发到那里/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('填表：格式不对就地提示、不发请求；对了才校验，授权码去掉空格；成功后回调', async () => {
    mockServer([]);
    const onConnected = vi.fn();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { ok: true, smtp_ok: true, account: account() } });
    render(<MailConnectCenter onConnected={onConnected} />);
    fireEvent.click(await screen.findByRole('button', { name: /QQ 邮箱/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '开始连接' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '我已获取授权码，下一步' }));
    fireEvent.change(within(dialog()).getByLabelText('邮箱地址'), { target: { value: 'me@qq.com' } });
    fireEvent.change(within(dialog()).getByLabelText('授权码'), { target: { value: 'abcd' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    expect(within(dialog()).getByText(/授权码是 16 位，现在 4 位/)).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();

    // 163 新版授权码字母数字混排，16 位就该放行（2026-10-31 实例测试：真实授权码被「只收字母」挡住）
    fireEvent.change(within(dialog()).getByLabelText('授权码'), { target: { value: 'Ab3dEf7hIj9kLm1!' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    expect(within(dialog()).getByText(/授权码只有字母和数字/)).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();

    fireEvent.change(within(dialog()).getByLabelText('授权码'), { target: { value: 'Ab3d Ef7h Ij9k Lm1n' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    expect(await within(dialog()).findByText('验证授权码')).toBeInTheDocument();
    expect(await within(dialog()).findByText('QQ 邮箱已连接', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/connectors/qq/verify', { email: 'me@qq.com', authCode: 'Ab3dEf7hIj9kLm1n', reauthorize: false });
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ address: 'me@qq.com' }));
  });

  it('授权码错：给「重新填写」和「查看教程」；已连接过：给「查看连接」进管理页', async () => {
    mockServer([]);
    vi.mocked(apiPostJson).mockResolvedValueOnce({ ok: true, result: { ok: false, error_code: 'imap_auth_failed', message: '授权码不对或已经失效。' } });
    render(<MailConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /QQ 邮箱/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '开始连接' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '我已获取授权码，下一步' }));
    fireEvent.change(within(dialog()).getByLabelText('邮箱地址'), { target: { value: 'me@qq.com' } });
    fireEvent.change(within(dialog()).getByLabelText('授权码'), { target: { value: 'abcdefghijklmnop' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    expect(await within(dialog()).findByText('授权码不正确或已失效', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: '查看教程' })).toBeInTheDocument();

    mockServer([account()]);
    vi.mocked(apiPostJson).mockResolvedValueOnce({ ok: true, result: { ok: false, error_code: 'duplicate', message: '这个邮箱已经连上了', account_id: 'm1' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '重新填写' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: '验证并连接' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: '查看连接' }, { timeout: 3000 }));
    expect(await within(dialog()).findByText('QQ 邮箱 连接管理')).toBeInTheDocument();
  });

  it('失效的连接：点卡片直接进引导（跳过说明），邮箱地址锁定，按「重新授权」提交', async () => {
    mockServer([account({ status: 'auth_failed', connection: { state: 'expired', health: 'expired' } })]);
    render(<MailConnectCenter />);
    expect(await screen.findByText('需要重新授权')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /QQ 邮箱/ }));
    expect(within(dialog()).queryByRole('button', { name: '开始连接' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: '我已获取授权码，下一步' }));
    expect(within(dialog()).getByLabelText('邮箱地址')).toHaveAttribute('readonly');
    expect(within(dialog()).getByRole('button', { name: '重新授权' })).toBeInTheDocument();
  });

  it('Gmail 的 OAuth 轨：未开放时说明现状、照常走授权码；开放后在浏览器授权，轮询到完成就连上', async () => {
    const gmail = (enabled: boolean) => ({ ...connector('gmail', 'Gmail'), oauth: { enabled } });
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => path === '/api/career/mail/connectors' ? { ok: true, connectors: [gmail(false)], accounts: [] } : { ok: true });
    const { unmount } = render(<MailConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    expect(within(dialog()).getByText(/官方一键授权审核通过后开放/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: '开始连接' })).toBeInTheDocument();
    unmount();

    const onConnected = vi.fn();
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path === '/api/career/mail/connectors') return { ok: true, connectors: [gmail(true)], accounts: [] };
      if (path.includes('/oauth/status')) return { ok: true, status: 'done', account: account({ provider: 'gmail', address: 'me@gmail.com' }) };
      if (path.endsWith('/detail')) return { ok: true, account: account({ provider: 'gmail', address: 'me@gmail.com' }), usage: { days: 7, by_op: {} }, audit: [] };
      return { ok: true };
    });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: { ok: true, authorize_url: 'https://accounts.google.com/o/oauth2/auth?x=1', state: 's1' } });
    render(<MailConnectCenter onConnected={onConnected} />);
    fireEvent.click(await screen.findByRole('button', { name: /Gmail/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: /用 Gmail 账号授权/ }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1'));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ address: 'me@gmail.com' })), { timeout: 4000 });
  });

  it('已连接：进管理页看用量和代发记录；解绑要输对邮箱地址', async () => {
    mockServer([account()]);
    render(<MailConnectCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /QQ 邮箱/ }));
    expect(await within(dialog()).findByText(/助理代发/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/给 hr@x.com：「应聘产品」/)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: '解绑这个邮箱' }));
    const confirm = within(dialog()).getByRole('button', { name: '解绑' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog()).getByLabelText('输入邮箱地址确认解绑'), { target: { value: 'me@qq.com' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/career/mail/accounts/m1'));
  });
});
