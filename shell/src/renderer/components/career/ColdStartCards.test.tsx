import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { StarterCard, TakeoverCard } from './ColdStartCards';
import type { CareerCard, TakeoverBriefing } from './types';

const soon = new Date(Date.now() + 2 * 86_400_000);
soon.setHours(10, 0, 0, 0);
const briefing: TakeoverBriefing = {
  report: { account_id: 'm1', address: 'me@qq.com', started_at: '', updated_at: '', viewed_at: null, mails: 96, by_rules: 80, by_model: 6, unclassified: 0, application_ids: [], span: { from: null, to: null } },
  applications: 9,
  buckets: [
    { id: 'applied', label: '已投递', items: ['美团', '网易', '小红书', '米哈游', '快手'].map((c, i) => ({ application_id: `ap${i}`, company: c, title: '产品经理', stage: 'applied' })) },
    { id: 'interview', label: '面试中', items: [{ application_id: 'a2', company: '阿里巴巴', title: '产品经理', stage: 'interview' }] },
    { id: 'offer', label: 'Offer', items: [] },
    { id: 'closed', label: '已结束', items: [{ application_id: 'c1', company: '京东', title: '运营', stage: 'rejected' }, { application_id: 'c2', company: '滴滴', title: '运营', stage: 'rejected' }, { application_id: 'c3', company: '携程', title: '运营', stage: 'rejected' }] },
  ],
  needs: [{ deadline_id: 'd1', application_id: 'a2', kind: 'interview', title: '阿里巴巴 · 产品经理 面试（二面）', due_at: soon.toISOString(), url: null }],
  season: { id: 'autumn', label: '秋招正式批', basis: '', source: 'guess' },
  seasons: [],
  unclassified: [],
};
const card = { id: 'takeover:m1', kind: 'takeover', title: '替你接管了这些申请', data: { account_id: 'm1' }, state: 'pending', toolUseId: null } as unknown as CareerCard;

describe('冷启动的对话卡片', () => {
  beforeEach(() => { vi.mocked(apiGetJson).mockReset(); });

  it('接管卡：最急一件放最大，几行事实带小签，已结束只写数字；看完整简报打开简报页并收起卡片', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, briefing });
    const onDone = vi.fn();
    render(<TakeoverCard card={card} onDone={onDone} />);
    const section = await screen.findByRole('region', { name: '接管卡' });
    expect(within(section).getByRole('heading', { name: '替你接管了 9 家公司的申请' })).toBeInTheDocument();
    expect(within(section).getByText('后天 10:00')).toBeInTheDocument();
    expect(within(section).getByText('+2')).toBeInTheDocument();
    expect(section).toHaveTextContent('3 已结束');
    expect(within(section).queryByText('京东')).not.toBeInTheDocument();
    const focus: unknown[] = [];
    const off = onEvent('career:focus', p => focus.push(p));
    fireEvent.click(within(section).getByRole('button', { name: '看完整简报' }));
    off();
    expect(focus).toEqual([{ surface: 'takeover', id: 'm1' }]);
    expect(onDone).toHaveBeenCalled();
  });

  it('起步卡：只在明确没有邮箱、也没有申请时出现', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => path.startsWith('/api/career/onboarding')
      ? { ok: true, checklist: { has_mail_account: false, has_application: false } }
      : { ok: true, connectors: [], accounts: [] });
    const { unmount } = render(<StarterCard />);
    expect(await screen.findByRole('region', { name: '起步卡' })).toHaveTextContent('有简历？直接把 PDF 拖到下面的输入框里');
    unmount();

    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, checklist: { has_mail_account: true, has_application: false } });
    render(<StarterCard />);
    await waitFor(() => expect(apiGetJson).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: '起步卡' })).not.toBeInTheDocument();
  });
});
