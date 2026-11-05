import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { annualOf, formatMoney, offerPoints } from '@/components/career/offer/OfferBoard';
import CareerOffer from './CareerOffer';
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

  it('看板：答复期限和一年的钱各一组条形，同一把尺子；缺的写未知，不画条', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers });
    render(<CareerOffer />);
    const deadlines = await screen.findByRole('region', { name: '答复期限' });
    expect(within(deadlines).getByText(/已过 \d+ 天/)).toBeInTheDocument();
    expect(within(deadlines).getByText('未知')).toBeInTheDocument();
    const pay = screen.getByRole('region', { name: '一年的钱' });
    expect(within(pay).getByText('37.5 万')).toBeInTheDocument();
    expect(within(pay).getByText('25000 × 15')).toBeInTheDocument();
    expect(within(pay).getByText('未知')).toBeInTheDocument();
    // 其余事实一个 Offer 一张卡；没填的留一道虚线
    expect(screen.getByText('方向一致')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: '未知' }).length).toBeGreaterThan(0);
  });

  it('要点由他填的数算出来：谁最先要答复、谁一年多多少、谁的钱还算不出；不说选哪个', () => {
    const now = new Date('2026-11-05T08:00:00+08:00');
    const base = offers[0];
    const a = { ...base, id: 'a', company_name: '甲公司', comp_json: JSON.stringify({ base: 22000, months: 15, signing: 20000 }), deadline: '2026-11-07T10:00:00+08:00' };
    const b = { ...base, id: 'b', company_name: '乙公司', comp_json: JSON.stringify({ base: 25000, months: 13 }), deadline: '2026-11-14T10:00:00+08:00' };
    const c = { ...base, id: 'c', company_name: '丙公司', comp_json: '{}', deadline: null };
    expect(offerPoints([b, a, c], now)).toEqual(['甲公司最先要答复：剩 2 天', '甲公司一年多 2.5 万', '丙公司的钱还算不出']);
    expect(offerPoints([c], now)).toEqual(['丙公司的钱还算不出']);
    expect(offerPoints([a], now)).toEqual(['甲公司最先要答复：剩 2 天']);
  });

  it('一年的钱只用他填的数：有年包合计用它，否则月薪 × 月数加签字费，不够就算不出', () => {
    expect(annualOf({ total: 375000, base: 1, months: 1 })).toBe(375000);
    expect(annualOf({ base: 22000, months: 15, signing: 20000 })).toBe(350000);
    expect(annualOf({ base: 22000 })).toBeNull();
    expect(formatMoney(350000)).toBe('35 万');
    expect(formatMoney(325000)).toBe('32.5 万');
    expect(formatMoney(8000)).toBe('8000');
  });

  it('让小芽拆开比：带着手上所有 Offer 的 id 发进对话', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, offers });
    const said: Array<{ text: string; context?: { refs?: Record<string, unknown> } }> = [];
    const off = onEvent('career:chat-suggest', (event: (typeof said)[number]) => { said.push(event); });
    render(<CareerOffer />);
    fireEvent.click(await screen.findByRole('button', { name: '让小芽拆开比' }));
    expect(said).toEqual([expect.objectContaining({ text: '把我手上的 Offer 拆开比一比', context: expect.objectContaining({ refs: { offer_ids: 'o1,o2' } }) })]);
    off();
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
});
