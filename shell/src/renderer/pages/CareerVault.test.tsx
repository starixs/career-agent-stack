import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiDelete, apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import CareerVault, { groupSites } from './CareerVault';
import type { VaultItemMeta } from '@/components/career/types';

const profileFields = [
  { field: 'name', label: '真实姓名', sensitive: true, group: 'identity' },
  { field: 'phone', label: '手机号', sensitive: true, group: 'contact' },
  { field: 'school', label: '毕业院校', sensitive: false, group: 'education' },
];
const phoneItem: VaultItemMeta = { id: 'v1', scope: 'profile', ref_id: '', field: 'phone', label: '手机号', preview: '138****8000', sensitive: true, policy: {}, created_at: '2026-10-01', updated_at: '2026-10-01' };
const siteItems: VaultItemMeta[] = [
  { id: 'v2', scope: 'site', ref_id: 'zhaopin.com', field: 'username', label: '智联', preview: 'm***@x.com', sensitive: true, policy: { autofill: true }, created_at: '2026-10-01', updated_at: '2026-10-01' },
  { id: 'v3', scope: 'site', ref_id: 'zhaopin.com', field: 'password', label: '智联', preview: '', sensitive: true, policy: { autofill: true }, created_at: '2026-10-01', updated_at: '2026-10-01' },
];

function mockGet(items: VaultItemMeta[]) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/vault/access-log')) return { ok: true, log: [] };
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
