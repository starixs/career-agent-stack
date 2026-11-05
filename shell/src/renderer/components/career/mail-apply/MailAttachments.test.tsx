/**
 * 邮件预览的附件那一行（R1）与跟进合成一件（R3）。数据按合同造（testFixtures.ts），接口用 apiFetch 替身。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import { MAIL_FILE_MAX_BYTES, type MailDraftView } from '../../../../shared/careerMailApply';
import type { AskView } from '../delivery/deliveryApi';
import { clearPendingDeck } from '../delivery/openDeck';
import { WaitingDock } from '../delivery/WaitingDock';
import { checkMailFile } from './MailAttachments';
import { FOLLOWUPS, mailAsk, REPLY, WITH_FILES } from './testFixtures';

const REVIEW = '/api/career/actions/review';
const DRAFT = (id: string) => `/api/career/mail-apply/drafts/${id}`;

function serve(asks: AskView[], drafts: MailDraftView[]) {
  vi.mocked(apiGetJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/career/asks')) return { ok: true, asks, run: null };
    if (url.startsWith('/api/career/mail-apply/drafts')) return { ok: true, drafts };
    return { ok: true };
  });
}

async function openDeck() {
  fireEvent.click(await screen.findByRole('button', { name: /等你\s*1/ }));
  await screen.findByTestId('ask-card-mail');
  await waitFor(() => expect(screen.queryByText('正在取邮件…')).toBeNull());
  return screen.getByTestId('ask-card-mail');
}

const rowOf = (card: HTMLElement) => within(card).getByTestId('mail-attachments');
const fileInput = (row: HTMLElement, i = 0) => row.querySelectorAll<HTMLInputElement>('input[type="file"]')[i];

beforeEach(() => {
  clearPendingDeck();
  vi.mocked(apiGetJson).mockReset();
  vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
});

describe('附件那一行', () => {
  it('简历 + 作品集文件 + 作品集链接签 + 存过的文件 + 钢笔蓝「加成绩单」+「加附件」', async () => {
    serve([mailAsk([WITH_FILES])], [WITH_FILES]);
    render(<WaitingDock />);
    const row = rowOf(await openDeck());
    expect(within(row).getByRole('button', { name: /看附件 北京邮电大学/ })).toHaveTextContent('按岗位改了 3 处');
    expect(within(row).getByText('作品集')).toBeInTheDocument();
    expect(within(row).getByText('作品集链接')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '加成绩单' })).toHaveClass('cm-want');
    expect(within(row).getByRole('button', { name: '+ 英语六级证书' })).toHaveClass('cm-opt');
    expect(within(row).getByRole('button', { name: '加附件' })).toHaveClass('cm-attach');
  });

  it('拿掉作品集文件、附上存过的证书、去掉作品集链接：各是一次改动', async () => {
    serve([mailAsk([WITH_FILES])], [WITH_FILES]);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, draft: WITH_FILES });
    render(<WaitingDock />);
    const row = rowOf(await openDeck());
    fireEvent.click(within(row).getByRole('button', { name: '拿掉 作品集' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(DRAFT('m_bd'), { remove_attachment_id: 'att_pf' }));
    fireEvent.click(within(row).getByRole('button', { name: '+ 英语六级证书' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(DRAFT('m_bd'), { add_file_id: 'f_cert' }));
    fireEvent.click(within(row).getByRole('button', { name: '去掉作品集链接' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(DRAFT('m_bd'), { include_portfolio: false }));
  });

  it('岗位要作品集、资料里没链接：「加作品集」原地贴链接，不像网址先说，回车存进资料', async () => {
    const want = { ...WITH_FILES, attachments: WITH_FILES.attachments.slice(0, 1), portfolio: { url: null, included: false }, wanted: ['portfolio' as const] };
    serve([mailAsk([want])], [want]);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, draft: want });
    render(<WaitingDock />);
    const row = rowOf(await openDeck());
    fireEvent.click(within(row).getByRole('button', { name: '加作品集' }));
    const input = within(row).getByLabelText('作品集链接');
    fireEvent.change(input, { target: { value: '我的作品集' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await within(screen.getByTestId('ask-card-mail')).findByRole('alert')).toHaveTextContent('这不像一个网址');
    fireEvent.change(input, { target: { value: 'https://zhouzihang.design' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(DRAFT('m_bd'), { portfolio_url: 'https://zhouzihang.design' }));
  });

  it('岗位要作品集、资料里有链接：一点带上', async () => {
    const want = { ...WITH_FILES, portfolio: { url: 'https://zhouzihang.design', included: false }, wanted: ['portfolio' as const] };
    serve([mailAsk([want])], [want]);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, draft: want });
    render(<WaitingDock />);
    fireEvent.click(within(rowOf(await openDeck())).getByRole('button', { name: '加作品集' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(DRAFT('m_bd'), { include_portfolio: true }));
  });

  it('加附件：类型不对、太大先挡下并说原因；合格的读成 base64 上传并附到这封，用返回的那封刷新', async () => {
    const fresh = { ...REPLY, attachments: [{ id: 'att_new', kind: 'file' as const, filename: '成绩单.pdf', resume_id: null, resume_label: '成绩单', tailored_changes: null }] };
    serve([mailAsk([REPLY], '京东 回信了')], [REPLY]);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, file: { id: 'f_new', label: '成绩单' }, draft: fresh });
    render(<WaitingDock />);
    const card = await openDeck();
    fireEvent.change(fileInput(rowOf(card)), { target: { files: [new File(['x'], 'run.exe')] } });
    expect(await within(card).findByRole('alert')).toHaveTextContent('这种文件发不了');
    fireEvent.change(fileInput(rowOf(card)), { target: { files: [new File(['%PDF'], '成绩单.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail-apply/files', expect.objectContaining({ name: '成绩单.pdf', action_id: 'm_re', base64: expect.any(String) })));
    expect(await within(rowOf(card)).findByText('成绩单')).toBeInTheDocument();
  });

  it('前端先挡的两条', () => {
    expect(checkMailFile({ name: 'a.PDF', size: 10 })).toBeNull();
    expect(checkMailFile({ name: 'noext', size: 10 })).toBe('这种文件发不了');
    expect(checkMailFile({ name: 'big.zip', size: MAIL_FILE_MAX_BYTES + 1 })).toBe('文件超过 10MB，换成链接更合适');
  });
});

describe('跟进合成一件（R3）', () => {
  const ask = () => mailAsk(FOLLOWUPS, '3 家可以再争取一下');

  it('三封：和投递邮件同一张表，「发出 3 封 · 先收起 · 这家不跟了」', async () => {
    serve([ask()], FOLLOWUPS);
    render(<WaitingDock />);
    const card = await openDeck();
    expect(within(card).getAllByRole('checkbox')).toHaveLength(3);
    const acts = card.querySelector<HTMLElement>('.cd-acts')!;
    expect(within(acts).getAllByRole('button').map(b => b.textContent)).toEqual(['发出 3 封', '先收起', '这家不跟了']);
  });

  it('「这家不跟了」只拒绝选中的那一封（不 drop），那行走掉，其余还在、卡组还开着', async () => {
    serve([ask()], FOLLOWUPS);
    render(<WaitingDock />);
    const card = await openDeck();
    fireEvent.click(within(card).getByRole('button', { name: /美团/ }));
    fireEvent.click(within(card).getByRole('button', { name: '这家不跟了' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['f_mt'], decision: 'rejected' }));
    await waitFor(() => expect(within(card).queryByTestId('mail-row-f_mt')).toBeNull());
    expect(within(card).getByRole('button', { name: '发出 2 封' })).toBeEnabled();
    expect(screen.getByTestId('waiting-deck')).toBeInTheDocument();
  });

  it('一封：「发出 · 不跟了」，没有「这家不跟了」', async () => {
    serve([mailAsk([FOLLOWUPS[0]], '京东 · 再争取一下')], [FOLLOWUPS[0]]);
    render(<WaitingDock />);
    const card = await openDeck();
    const acts = card.querySelector<HTMLElement>('.cd-acts')!;
    expect(within(acts).getAllByRole('button').map(b => b.textContent)).toEqual(['发出', '不跟了']);
  });
});
