import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
const cfg = vi.hoisted(() => ({
  apiKeys: {} as Record<string, string>,
  config: {} as Record<string, unknown>,
  saveApiKey: vi.fn(async () => {}),
  updateConfig: vi.fn(async () => {}),
}));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => cfg }));
vi.mock('./CareerPrimitives', async (orig) => {
  const actual = await orig<typeof import('./CareerPrimitives')>();
  // 主题化下拉依赖壳组件；测试里换成一组按钮（一项一个），点哪个就选哪个
  return { ...actual, Select: ({ options, onChange, ariaLabel }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; ariaLabel?: string }) => (
    <div role="group" aria-label={ariaLabel}>{options.map(o => <button key={o.value} type="button" onClick={() => onChange(o.value)}>{o.label}</button>)}</div>
  ) };
});

import { apiGetJson } from '@/api/apiFetch';

import { CareerSetupCards } from './CareerChatCards';
import { CareerKeysPanel } from './CareerKeysPanel';

const status = (llm: boolean, search: boolean) => ({ ok: true, setup: {
  llm: { configured: llm, source: llm ? 'settings' : 'none' },
  search: { configured: search, source: search ? 'settings' : 'none', provider: search ? 'bocha' : null },
} });

describe('模型 / 搜索 Key 配置', () => {
  beforeEach(() => {
    cfg.apiKeys = {}; cfg.config = {};
    cfg.saveApiKey.mockClear(); cfg.updateConfig.mockClear();
    vi.mocked(apiGetJson).mockReset().mockResolvedValue(status(false, false));
    try { window.localStorage.removeItem('career.searchSetupDismissed'); } catch { /* ignore */ }
  });

  it('模型 Key 存到内置 provider career-llm', async () => {
    render(<CareerKeysPanel />);
    fireEvent.change(screen.getByLabelText('模型 API Key'), { target: { value: ' sk-abc ' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);
    await waitFor(() => expect(cfg.saveApiKey).toHaveBeenCalledWith('career-llm', 'sk-abc'));
    expect(await screen.findByRole('status')).toHaveTextContent('模型 Key 已保存');
  });

  it('搜索 Key 连同提供方一起保存', async () => {
    render(<CareerKeysPanel show="search" />);
    fireEvent.click(screen.getByRole('button', { name: 'Tavily' }));
    fireEvent.change(screen.getByLabelText('搜索 API Key'), { target: { value: 'tvly-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(cfg.saveApiKey).toHaveBeenCalledWith('career-search', 'tvly-1'));
    expect(cfg.updateConfig).toHaveBeenCalledWith({ careerSearchProvider: 'tavily' });
  });

  it('已保存的 Key 只显示掩码', async () => {
    cfg.apiKeys = { 'career-llm': 'sk-1234567890' };
    render(<CareerKeysPanel show="llm" />);
    expect(screen.getByText('已保存 sk-****7890')).toBeInTheDocument();
    expect(screen.queryByText('sk-1234567890')).not.toBeInTheDocument();
  });

  it('对话底部：没有模型 Key 时显示必需卡片；只缺搜索时可"暂不配置"且记住', async () => {
    const { unmount } = render(<CareerSetupCards />);
    expect(await screen.findByText('先配置模型 Key，助理才能开始工作')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂不配置' })).not.toBeInTheDocument();
    unmount();

    vi.mocked(apiGetJson).mockResolvedValue(status(true, false));
    const second = render(<CareerSetupCards />);
    expect(await screen.findByText('建议配置搜索 Key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂不配置' }));
    expect(screen.queryByTestId('career-setup-cards')).not.toBeInTheDocument();
    second.unmount();

    render(<CareerSetupCards />);
    await waitFor(() => expect(apiGetJson).toHaveBeenCalled());
    expect(screen.queryByTestId('career-setup-cards')).not.toBeInTheDocument();
  });

  it('都配好了就不显示', async () => {
    vi.mocked(apiGetJson).mockResolvedValue(status(true, true));
    render(<CareerSetupCards />);
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledWith('/api/career/setup'));
    expect(screen.queryByTestId('career-setup-cards')).not.toBeInTheDocument();
  });
});
