import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import type { TakeoverBriefing } from '@/components/career/types';
import CareerTakeover from './CareerTakeover';

const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
const briefing: TakeoverBriefing = {
  report: { account_id: 'm1', address: 'me@qq.com', started_at: '2026-10-30T08:00:00Z', updated_at: '2026-10-30T08:05:00Z', viewed_at: null, mails: 96, by_rules: 80, by_model: 6, unclassified: 2, application_ids: ['a1', 'a2', 'a3'], span: { from: '2026-08-20T02:00:00Z', to: '2026-10-28T03:00:00Z' } },
  applications: 3,
  buckets: [
    { id: 'applied', label: '已投递', items: [{ application_id: 'a1', company: '美团', title: '产品经理', stage: 'applied' }] },
    { id: 'interview', label: '面试中', items: [{ application_id: 'a2', company: '阿里巴巴', title: '产品经理', stage: 'interview' }] },
    { id: 'offer', label: 'Offer', items: [] },
    { id: 'closed', label: '已结束', items: [{ application_id: 'a3', company: '京东', title: '运营', stage: 'rejected' }] },
  ],
  needs: [{ deadline_id: 'd1', application_id: 'a2', kind: 'interview', title: '阿里巴巴 · 产品经理 面试（二面）', due_at: soon, url: null }],
  season: { id: 'autumn', label: '秋招正式批', basis: '近 30 天收到 40 封求职邮件，现在是 10 月', source: 'guess' },
  seasons: [{ id: 'prep', label: '准备期' }, { id: 'autumn_early', label: '秋招提前批' }, { id: 'autumn', label: '秋招正式批' }, { id: 'spring', label: '春招' }, { id: 'offer', label: 'Offer 与三方' }],
  unclassified: [{ mail_id: 'x1', subject: '您有一条新的通知', from: 'noreply@mokahr.com', received_at: '2026-09-25T03:00:00Z' }],
};

describe('接管简报', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true, season: { id: 'spring', label: '春招', basis: '你自己选的', source: 'user' } });
  });

  it('先说接管了几家，再放要你的事、阶段判断与依据、按阶段的申请、没认出的邮件；打开即记为看过', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, briefing });
    render(<CareerTakeover isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: '替你接管了 3 家公司的申请' })).toBeInTheDocument();
    expect(screen.getByText(/来自 me@qq.com 8 月 20 日～10 月 28 日 的 96 封求职邮件/)).toBeInTheDocument();
    const needs = screen.getByRole('region', { name: '现在要你的事' });
    expect(within(needs).getByText('阿里巴巴 · 产品经理 面试（二面）')).toBeInTheDocument();
    expect(screen.getByText('依据：近 30 天收到 40 封求职邮件，现在是 10 月')).toBeInTheDocument();
    const apps = screen.getByRole('region', { name: '接管的申请' });
    // 已结束只写数字，名单收起来，点开才看
    expect(within(apps).queryByRole('button', { name: /京东/ })).not.toBeInTheDocument();
    fireEvent.click(within(apps).getByRole('button', { name: '看名单' }));
    expect(within(apps).getByRole('button', { name: '京东 · 运营' })).toBeInTheDocument();
    expect(within(apps).getByRole('button', { name: '美团 · 产品经理' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '没认出来的 1 封' })).toHaveTextContent('您有一条新的通知');
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail/takeover/m1/viewed', {}));
  });

  it('阶段不对点一下就改；点要你的事跳到那份申请', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, briefing });
    render(<CareerTakeover isActive onOpenChat={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: '春招' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/season', { id: 'spring' }));
    expect(await screen.findByText('你选的')).toBeInTheDocument();

    const focus: unknown[] = [];
    const off = onEvent('career:focus', p => focus.push(p));
    fireEvent.click(screen.getByRole('button', { name: /阿里巴巴 · 产品经理 面试/ }));
    off();
    expect(focus).toEqual([{ surface: 'dossier', application_id: 'a2' }]);
  });

  it('准备期没东西可接管：写阶段与下一步，不写空白，也没有钢笔蓝的要你的事', async () => {
    const prep: TakeoverBriefing = { ...briefing, applications: 0, buckets: briefing.buckets.map(b => ({ ...b, items: [] })), needs: [], unclassified: [], season: { id: 'prep', label: '准备期', basis: '邮箱里还没有求职邮件，也没有投递记录', source: 'guess' } };
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => path.startsWith('/api/career/onboarding')
      ? { ok: true, checklist: { has_experience: false, has_mail_account: true, has_application: false } }
      : { ok: true, briefing: prep });
    const onOpenChat = vi.fn();
    render(<CareerTakeover isActive onOpenChat={onOpenChat} />);
    expect(await screen.findByRole('heading', { name: '你还在准备期，邮箱里还没有求职邮件' })).toBeInTheDocument();
    expect(screen.getByText('（往年规律，具体以公告为准）')).toBeInTheDocument();
    expect(await screen.findByText(/经历库还是空的/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '现在要你的事' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去对话里拖简历' }));
    expect(onOpenChat).toHaveBeenCalled();
  });

  it('还没有简报：说明会在什么时候出现，并给出连接中心', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => path.startsWith('/api/career/mail/connectors')
      ? { ok: true, connectors: [{ id: 'qq', name: 'QQ 邮箱', auth_type: 'credential_form', capabilities: ['receive'], open_url: '', open_label: '', help_url: null, guide: [], verify_note: '', fields: [] }], accounts: [] }
      : { ok: true, briefing: null });
    render(<CareerTakeover isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText(/还没有接管简报/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /QQ 邮箱/ })).toBeInTheDocument();
  });
});
