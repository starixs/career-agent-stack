import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import CareerVault, { ACCOUNTS, accountFetchMessage, fetchStateLabel, groupSites } from './CareerVault';
import type { VaultItemMeta } from '@/components/career/types';

const profileFields = [
  { field: 'name', label: '真实姓名', sensitive: true, group: 'identity' },
  { field: 'gender', label: '性别', sensitive: false, group: 'identity' },
  { field: 'ethnicity', label: '民族', sensitive: false, group: 'identity' },
  { field: 'phone', label: '手机号', sensitive: true, group: 'contact' },
  { field: 'school', label: '毕业院校', sensitive: false, group: 'education' },
];
const phoneItem: VaultItemMeta = { id: 'v1', scope: 'profile', ref_id: '', field: 'phone', label: '手机号', preview: '138****8000', sensitive: true, policy: {}, created_at: '2026-10-01', updated_at: '2026-10-01' };
const siteItems: VaultItemMeta[] = [
  { id: 'v2', scope: 'site', ref_id: 'zhaopin.com', field: 'username', label: '智联', preview: 'm***@x.com', sensitive: true, policy: { autofill: true }, created_at: '2026-10-01', updated_at: '2026-10-01' },
  { id: 'v3', scope: 'site', ref_id: 'zhaopin.com', field: 'password', label: '智联', preview: '', sensitive: true, policy: { autofill: true }, created_at: '2026-10-01', updated_at: '2026-10-01' },
];

let fetchStates: Record<string, unknown> = {};
function mockGet(items: VaultItemMeta[]) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/vault/access-log')) return { ok: true, log: [] };
    if (path.startsWith('/api/career/accounts')) return { ok: true, accounts: fetchStates };
    if (path.startsWith('/api/career/vault')) {
      const filled = items.filter(i => i.scope === 'profile').map(i => ({ field: i.field, label: i.label, preview: i.preview, sensitive: i.sensitive }));
      return { ok: true, items, profileFields, siteFields: ['username', 'password', 'note'], status: { profile: { filled, missing: [] }, sites: [], experiences: [] } };
    }
    if (path.startsWith('/api/career/experiences')) return { ok: true, experiences: [{ id: 'e1', title: '某头部电商实习', org: null, role: null, start_date: null, end_date: null, type: 'intern', summary: null, redacted: 1, created_at: '', updated_at: '', claims: [] }] };
    return { ok: true };
  });
}

describe('CareerVault', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiPutJson).mockReset();
    vi.mocked(apiDelete).mockReset();
  });

  it('只显示脱敏预览；未填项显示"未填"', async () => {
    mockGet([phoneItem]);
    render(<CareerVault />);
    expect(await screen.findByText('138****8000')).toBeInTheDocument();
    expect(screen.getByTestId('vault-preview-name')).toHaveTextContent('未填');
    expect(screen.getAllByText('不进模型').length).toBeGreaterThan(0);
    expect(screen.getByText('可给模型')).toBeInTheDocument();
  });

  it('只显示身份和联系方式：教育、求职偏好、民族这些不再让用户填', async () => {
    mockGet([]);
    render(<CareerVault />);
    expect(await screen.findByText('真实姓名')).toBeInTheDocument();
    expect(screen.getByText('性别')).toBeInTheDocument();
    expect(screen.getByText('手机号')).toBeInTheDocument();
    expect(screen.queryByText('毕业院校')).toBeNull();
    expect(screen.queryByText('民族')).toBeNull();
  });

  it('绑定账号：GitHub 填主页后存进私密库（可给模型），并让助理抓一次', async () => {
    mockGet([]);
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true, item: null });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, state: { status: 'requested' } });
    const suggested: unknown[] = [];
    const off = onEvent('career:chat-suggest', p => suggested.push(p));
    render(<CareerVault />);
    expect(await screen.findByTestId('account-github')).toHaveTextContent('未绑定');
    const row = screen.getByTestId('account-github').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '绑定' }));
    fireEvent.change(within(row).getByLabelText('GitHub 用户名或主页'), { target: { value: 'https://github.com/me' } });
    fireEvent.click(within(row).getByRole('button', { name: '绑定' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'profile', field: 'github', value: 'https://github.com/me', label: 'GitHub', sensitive: false }));
    await waitFor(() => expect(suggested).toHaveLength(1));
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/accounts/github/request', {});
    expect(suggested[0]).toMatchObject({ text: '我绑定了GitHub（https://github.com/me）。请把公开仓库，挑出能写进简历的项目抓一次，整理进我的资料。抓完用 account_fetch_report 回报结果（field=github）。', context: { surface: 'vault' } });
    off();
  });

  it('抓取状态：显示上次抓取时间；登录过期时标出来，按钮变成「重新绑定」', async () => {
    const linkedin: VaultItemMeta = { ...phoneItem, id: 'v9', field: 'linkedin', label: '领英', preview: 'https://www.linkedin.com/in/me', sensitive: false };
    const github: VaultItemMeta = { ...phoneItem, id: 'v8', field: 'github', label: 'GitHub', preview: 'https://github.com/me', sensitive: false };
    fetchStates = {
      github: { status: 'ok', requested_at: '2026-10-01', fetched_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), note: null },
      linkedin: { status: 'login_expired', requested_at: '2026-10-01', fetched_at: null, note: '打开是登录页' },
    };
    mockGet([linkedin, github]);
    render(<CareerVault />);
    expect(await screen.findByTestId('account-state-github')).toHaveTextContent('上次抓取 3 天前');
    expect(await screen.findByTestId('account-state-linkedin')).toHaveTextContent('登录已过期');
    const row = screen.getByTestId('account-linkedin').closest('li')!;
    expect(within(row).getByText('登录过期')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '重新绑定' })).toBeInTheDocument();
    fetchStates = {};
  });

  it('fetchStateLabel：请求中 / 失败带原因', () => {
    expect(fetchStateLabel({ status: 'requested', requested_at: '', fetched_at: null, note: null })).toEqual({ text: '已交给小芽，等它抓完', expired: false });
    expect(fetchStateLabel({ status: 'failed', requested_at: '', fetched_at: null, note: '页面打不开' })).toEqual({ text: '上次没抓到：页面打不开', expired: false });
    expect(fetchStateLabel(null)).toBeNull();
  });

  it('需要登录的账号：让助理打开网站、登录交给本人', () => {
    const chsi = ACCOUNTS.find(a => a.field === 'chsi')!;
    expect(chsi.input).toBeNull();
    expect(accountFetchMessage(chsi, null)).toContain('需要登录就交给我自己登录');
    expect(accountFetchMessage(chsi, null)).toContain('https://my.chsi.com.cn');
  });

  it('编辑手机号：先 reveal 明文再 PUT 保存', async () => {
    mockGet([phoneItem]);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, value: '13800138000' });
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true, item: phoneItem });
    render(<CareerVault />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑手机号' }));
    const input = await screen.findByLabelText('手机号') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('13800138000'));
    expect(input.type).toBe('password');
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/vault/items/v1/reveal', {});
    fireEvent.change(input, { target: { value: '13900139000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'profile', field: 'phone', value: '13900139000' }));
  });

  it('添加网站账号：账号 / 密码各写一条，带 autofill 策略', async () => {
    mockGet([]);
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true, item: null });
    render(<CareerVault />);
    fireEvent.click(await screen.findByRole('button', { name: /更多/ }));
    fireEvent.click(await screen.findByRole('button', { name: '添加网站账号' }));
    fireEvent.change(screen.getByLabelText('网站域名'), { target: { value: 'zhaopin.com' } });
    fireEvent.change(screen.getByLabelText('账号 / 手机 / 邮箱'), { target: { value: 'me@x.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw-123456' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledTimes(2));
    const bodies = vi.mocked(apiPutJson).mock.calls.map(c => c[1] as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ scope: 'site', ref_id: 'zhaopin.com', field: 'username', value: 'me@x.com', policy: { autofill: false } });
    expect(bodies[1]).toMatchObject({ scope: 'site', field: 'password', value: 'pw-123456' });
  });

  it('经历保密补充：展开经历并添加字段', async () => {
    mockGet([]);
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true, item: null });
    render(<CareerVault focusExperienceId="e1" />);
    expect(await screen.findByText('某头部电商实习')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('字段名（英文）'), { target: { value: 'org' } });
    fireEvent.change(screen.getByLabelText('内容（真实值）'), { target: { value: '真实公司名' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/vault/items', { scope: 'experience', ref_id: 'e1', field: 'org', value: '真实公司名', label: null }));
  });

  it('groupSites 把 username / password 合成一行', () => {
    expect(groupSites(siteItems)).toEqual([{ host: 'zhaopin.com', label: '智联', items: siteItems, hasPassword: true, usernamePreview: 'm***@x.com', autofill: true }]);
  });
});
