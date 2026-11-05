import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import CareerOffer, { decisionItems } from './CareerOffer';
import type { Offer } from '@/components/career/types';

const offers: Offer[] = [
  { id: 'o1', application_id: null, company_name: '丙公司', title: '后端工程师', comp_json: JSON.stringify({ base: 25000, months: 15, total: 375000 }), location: '上海', content_match: '方向一致', risk_notes: '业务线可能调整', deadline: '2026-10-15', created_at: '2026-10-01', updated_at: '2026-10-01' },
  { id: 'o2', application_id: null, company_name: '丁公司', title: '算法工程师', comp_json: '{}', location: null, content_match: null, risk_notes: null, deadline: null, created_at: '2026-10-02', updated_at: '2026-10-02' },
];

describe('CareerOffer', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiPutJson).mockReset();
  });

  it('空状态', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers: [] });
    render(<CareerOffer />);
    expect(await screen.findByText('还没有 Offer')).toBeInTheDocument();
  });

  it('渲染卡片、对比表与需要你决定的项：薪酬用中文与千分位，决定项按公司分组、空字段不生成套话', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers });
    render(<CareerOffer />);
    expect((await screen.findAllByText('丙公司 · 后端工程师')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('25,000 × 15 个月 · 年包 375,000').length).toBeGreaterThan(0);
    expect(screen.getByText('对比')).toBeInTheDocument();
    expect(screen.queryByText('未知')).not.toBeInTheDocument();
    expect(screen.getByText('薪酬拆解还没填')).toBeInTheDocument();
    expect(screen.getByText('风险：业务线可能调整')).toBeInTheDocument();
    expect(screen.queryByText(/工作内容是否匹配/)).not.toBeInTheDocument();
  });

  it('只有一个 Offer：不渲染对比表；接口键名不出现在薪酬里', async () => {
    const comp = { base_monthly: 26000, months: 16, sign_on: 30000, notes: '含期权' };
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers: [{ ...offers[0], comp_json: JSON.stringify(comp) }] });
    render(<CareerOffer />);
    expect(await screen.findByText('26,000 × 16 个月 · 签字费 30,000 · 含期权')).toBeInTheDocument();
    expect(screen.queryByText('对比')).not.toBeInTheDocument();
    expect(screen.queryByText(/base_monthly|sign_on|notes/)).not.toBeInTheDocument();
  });

  it('新建 Offer 调用 POST /api/career/offers，薪酬数字转为 number', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers: [] });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, offer: { id: 'o9' } });
    render(<CareerOffer />);
    fireEvent.click(await screen.findByRole('button', { name: '新建 Offer' }));
    fireEvent.change(screen.getByLabelText('公司'), { target: { value: '戊公司' } });
    fireEvent.change(screen.getByLabelText('岗位'), { target: { value: '平台工程师' } });
    fireEvent.change(screen.getByLabelText('月薪 / 基本'), { target: { value: '30000' } });
    fireEvent.change(screen.getByLabelText('截止日期'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPostJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/offers');
    expect(body).toMatchObject({ company_name: '戊公司', title: '平台工程师', deadline: '2026-10-20' });
    expect(JSON.parse(body.comp_json as string)).toEqual({ base: 30000 });
  });

  it('编辑已有 Offer 调用 PUT /api/career/offers/:id', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers });
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true });
    render(<CareerOffer />);
    fireEvent.click((await screen.findAllByRole('button', { name: '编辑' }))[0]);
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '杭州' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPutJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/offers/o1');
    expect(body).toMatchObject({ location: '杭州' });
  });

  it('来信建的 Offer（期限是 ISO 时刻）：编辑框按北京日期显示；没改日期就不回写，保住原来的时刻', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers: [{ ...offers[0], deadline: '2026-11-21T02:00:00.000Z' }] });
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true });
    render(<CareerOffer />);
    fireEvent.click((await screen.findAllByRole('button', { name: '编辑' }))[0]);
    expect((screen.getByLabelText('截止日期') as HTMLInputElement).value).toBe('2026-11-21');
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '杭州' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledTimes(1));
    const body = vi.mocked(apiPutJson).mock.calls[0][1] as Record<string, unknown>;
    expect(body.deadline).toBeUndefined();
  });

  it('decisionItems：按公司分组，只列有依据的项', () => {
    expect(decisionItems(offers)).toEqual([
      { name: '丙公司 · 后端工程师', items: ['风险：业务线可能调整', '10 月 15 日前答复'] },
      { name: '丁公司 · 算法工程师', items: ['薪酬拆解还没填'] },
    ]);
  });
});
