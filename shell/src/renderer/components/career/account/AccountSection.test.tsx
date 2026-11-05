import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(async () => ({ ok: true })) }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import { AccountSection } from './AccountSection';

const summary = {
  account: { tier: 'free', credits: 43, subscription_credits: 0, subscription_expires_at: null },
  balance: 43,
  windowDays: 30,
  spentInWindow: 7,
  buckets: [
    { origin: 'chat', kind: 'llm', name: 'deepseek-v4-flash', calls: 3, credits: 6, unpricedCalls: 0 },
    { origin: 'tool', kind: 'tool', name: 'search:bocha', calls: 1, credits: 1, unpricedCalls: 0 },
  ],
  daily: [],
  events: [{ event: 'application_sent', label: '替你投出', unit: '份', count: 23 }, { event: 'resume_tailored', label: '按岗位定制简历', unit: '份', count: 9 }],
  recent: [{ id: 't1', type: 'earn', amount: 50, balance_after: 50, source_type: 'signup', description: '开户赠送', created_at: '2026-11-05T00:00:00Z' }],
};
const priceList = {
  creditUnitPriceCents: 20,
  models: [{ model: 'deepseek-v4-flash', label: '内置模型', inputPerMillion: 35, outputPerMillion: 70, cachePerMillion: 0.7 }],
  tools: [{ tool: 'search:bocha', label: '联网搜索（博查）', credits: 1 }, { tool: 'web_fetch', label: '读网页', credits: 0 }],
  asr: { freeSeconds: 180, creditsPerMinute: 0.2 },
  signupGrantCredits: 50,
  checkinDailyCredits: { free: 2, sprint: 5 },
  plans: [{ id: 'sprint_monthly', name: '冲刺月卡', billingPeriod: 'month', priceCents: 3900, creditsGranted: 250, badge: null }],
  topupPackages: [{ id: 'p', credits: 50, priceCents: 1000 }],
};

describe('设置 › 账号与用量', () => {
  it('余额、用在哪了、流水、计费清单都渲出来；签到后刷新', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => (path.endsWith('/summary') ? { summary } : { priceList }));
    render(<AccountSection />);
    expect(await screen.findByText('43')).toBeTruthy();
    expect(screen.getByText('最近 30 天用了 7 积分')).toBeTruthy();
    expect(screen.getByText('最近 30 天替你做了')).toBeTruthy();
    expect(screen.getByText('23')).toBeTruthy();
    expect(screen.getByText('替你投出')).toBeTruthy();
    expect(screen.getByText('和小芽对话')).toBeTruthy();
    expect(screen.getByText('联网搜索')).toBeTruthy();
    expect(await screen.findByText('1 元 = 5 积分')).toBeTruthy();
    // 流水里一行、计费清单里一行
    expect(screen.getAllByText('开户赠送')).toHaveLength(2);
    expect(screen.getByText('输入 35 · 输出 70 · 缓存命中 0.7')).toBeTruthy();
    expect(screen.queryByText('读网页')).toBeNull();
    expect(screen.getByText('¥39 / 月 · 250 积分')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '今日签到' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/billing/checkin', {}));
  });
});
