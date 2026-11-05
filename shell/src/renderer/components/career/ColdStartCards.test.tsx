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

  it('起步卡（两扇门）：没有简历也没有经历时出现；「先聊聊」把开场白发进对话，「选个文件」请输入框打开文件选择', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, checklist: { has_master_resume: false, has_experience: false } });
    const { unmount } = render(<StarterCard />);
    const section = await screen.findByRole('region', { name: '起步卡' });
    // 开场是小芽的三条短话（对话里她说话的样式），不是卡片标题
    expect(within(section).getAllByTestId('speech-block').map(b => b.textContent)).toEqual([
      '我是小芽。我帮你把网申从写简历一路做到投出去。', '每一步你都看得见，提交之前一定先给你看。', '你手上有简历吗？',
    ]);
    expect(within(section).queryByRole('heading')).not.toBeInTheDocument();
    const sent: unknown[] = [];
    const picks: unknown[] = [];
    const offSend = onEvent('career:chat-suggest', p => sent.push(p));
    const offPick = onEvent('career:pick-resume', p => picks.push(p));
    fireEvent.click(within(section).getByRole('button', { name: '还没有，先聊聊' }));
    fireEvent.click(within(section).getByRole('button', { name: '有，选个文件给我' }));
    offSend(); offPick();
    expect(sent).toEqual([{ text: '我没有简历，先聊聊我做过的事', context: undefined, mode: 'send' }]);
    expect(picks).toHaveLength(1);
    unmount();

    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, checklist: { has_master_resume: true, has_experience: false } });
    render(<StarterCard />);
    await waitFor(() => expect(apiGetJson).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: '起步卡' })).not.toBeInTheDocument();
  });
});
