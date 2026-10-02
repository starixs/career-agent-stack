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

  it('渲染卡片、对比表与需要你决定的项；缺数据标未知', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers });
    render(<CareerOffer />);
    expect((await screen.findAllByText('丙公司 · 后端工程师')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/月薪 \/ 基本 25000 · 月数 15 · 年包合计 375000/).length).toBeGreaterThan(0);
    expect(screen.getByText('对比')).toBeInTheDocument();
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
    expect(screen.getByText('丁公司 · 算法工程师：薪酬拆解未知，需要你补充')).toBeInTheDocument();
    expect(screen.getByText('丙公司 · 后端工程师：风险「业务线可能调整」是否可接受，需要你决定')).toBeInTheDocument();
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

  it('decisionItems：多个 Offer 时提醒取舍由你决定', () => {
    const items = decisionItems(offers);
    expect(items.some(i => i.includes('取舍只能由你决定'))).toBe(true);
    expect(items.some(i => i.includes('2026-10-15 前要答复'))).toBe(true);
  });
});
