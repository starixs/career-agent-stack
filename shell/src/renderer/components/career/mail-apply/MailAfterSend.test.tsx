/**
 * 邮件投递 · 发出之后（P2.8、F5、F6）：回信预览带对方原信、退信重发、邮件失败那件的按钮、
 * 连邮箱浮层的 Esc、一份申请的邮件往来。数据按 shared/careerMailApply.ts 合同造（testFixtures.ts）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';

import type { MailDraftView } from '../../../../shared/careerMailApply';
import type { AskView } from '../delivery/deliveryApi';
import { OPEN_DECK_EVENT } from '../delivery/ReturnCard';
import { WaitingDock } from '../delivery/WaitingDock';
import { MailThread } from './MailThread';
import { BLOCKED, BOUNCED, bouncedAsk, failedMailAsk, mailAsk, MULTI, REPLY, THREAD } from './testFixtures';

const REVIEW = '/api/career/actions/review';

function serve(asks: AskView[], drafts: MailDraftView[]) {
  vi.mocked(apiGetJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/career/asks')) return { ok: true, asks, run: null };
    if (url.startsWith('/api/career/mail-apply/drafts')) {
      const ids = decodeURIComponent(url.split('ids=')[1] ?? '').split(',');
      return { ok: true, drafts: drafts.filter(d => ids.includes(d.action_id)) };
    }
    return { ok: true };
  });
}

async function openDeck(testId = 'ask-card-mail') {
  fireEvent.click(await screen.findByRole('button', { name: /等你\s*1/ }));
  await screen.findByTestId(testId);
  await waitFor(() => expect(screen.queryByText('正在取邮件…')).toBeNull());
  return screen.getByTestId(testId);
}

const actsOf = (card: HTMLElement) => card.querySelector<HTMLElement>('.cd-acts')!;
const buttonsOf = (card: HTMLElement) => within(actsOf(card)).getAllByRole('button').map(b => b.textContent);

beforeEach(() => {
  vi.mocked(apiGetJson).mockReset();
  vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
});

describe('回信与退信', () => {
  it('回信：标题上方是对方那封（发件人、正文），按钮「发出 · 我自己回」；我自己回只拒绝这封', async () => {
    serve([mailAsk([REPLY], '京东 回信了')], [REPLY]);
    render(<WaitingDock />);
    const card = await openDeck();
    const quote = await within(card).findByTestId('mail-incoming');
    expect(quote).toHaveTextContent('王莉 <wangli@jd.example>');
    expect(quote).toHaveTextContent('你最早什么时候能到岗');
    expect(quote.compareDocumentPosition(within(card).getByLabelText('标题')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(buttonsOf(card)).toEqual(['发出', '我自己回']);
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '我自己回' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_re'], decision: 'rejected' }));
  });

  it('对方的长信先收着，点「展开全文」看全', async () => {
    const long = { ...REPLY, incoming: { from: '王莉 <wangli@jd.example>', received_at: '2026-11-05T03:12:00.000Z', text: '第一行\n第二行\n第三行\n第四行\n第五行' } };
    serve([mailAsk([long], '京东 回信了')], [long]);
    render(<WaitingDock />);
    const card = await openDeck();
    const more = await within(card).findByRole('button', { name: '展开全文' });
    expect(card.querySelector('.cm-quote-text')).toHaveClass('is-clamped');
    fireEvent.click(more);
    expect(card.querySelector('.cm-quote-text')).not.toHaveClass('is-clamped');
  });

  it('退信：收件人标红、主按钮「改好了，重发」不可点；改好地址后可点，发出就是批准这封', async () => {
    serve([bouncedAsk()], [BOUNCED]);
    vi.mocked(apiPostJson).mockImplementation(async (url: string) => (url.endsWith('/m_bo')
      ? { ok: true, draft: { ...BOUNCED, to: 'hr@dji.example', blockers: [] } }
      : { ok: true }));
    render(<WaitingDock />);
    const card = await openDeck();
    const to = await within(card).findByLabelText('收件人');
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(buttonsOf(card)).toEqual(['改好了，重发', '不投这家']);
    expect(within(actsOf(card)).getByRole('button', { name: '改好了，重发' })).toBeDisabled();
    fireEvent.change(to, { target: { value: 'hr@dji.example' } });
    fireEvent.blur(to);
    await waitFor(() => expect(within(actsOf(card)).getByRole('button', { name: '改好了，重发' })).toBeEnabled());
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '改好了，重发' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_bo'], decision: 'approved' }));
  });
});

describe('邮件没写成 / 没发出去（F5）', () => {
  it('没写成：「再写一次 · 晚点」，再写一次走重试接口，没有「我自己来」', async () => {
    const ask = failedMailAsk({ stage: 'draft', reauth: false });
    serve([ask], []);
    render(<WaitingDock />);
    const card = await openDeck('ask-card-mail-failed');
    expect(buttonsOf(card)).toEqual(['再写一次', '晚点']);
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '再写一次' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(`/api/career/asks/${ask.id}/retry`, {}));
  });

  it('没发出去：「再发一次」放回待发，再打开卡组定位到重新出现的那件；不直接发', async () => {
    const ask = failedMailAsk({ stage: 'send', reauth: false });
    serve([ask], []);
    render(<WaitingDock />);
    const card = await openDeck('ask-card-mail-failed');
    expect(buttonsOf(card)).toEqual(['再发一次', '晚点']);
    const back = mailAsk(MULTI.slice(0, 2));
    serve([back], MULTI.slice(0, 2));
    const opened = vi.fn();
    const off = onEvent<{ id?: string }>(OPEN_DECK_EVENT, p => opened(p?.id));
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '再发一次' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(back.id));
    off();
    expect(apiPostJson).toHaveBeenCalledWith(`/api/career/asks/${ask.id}/retry`, {});
    expect(apiPostJson).not.toHaveBeenCalledWith(REVIEW, expect.anything());
    expect(await screen.findByTestId('ask-card-mail')).toBeInTheDocument();
  });

  it('邮箱授权失效：主按钮「重新连邮箱」打开连接，不先重试', async () => {
    serve([failedMailAsk({ stage: 'send', reauth: true })], []);
    render(<WaitingDock />);
    const card = await openDeck('ask-card-mail-failed');
    expect(buttonsOf(card)).toEqual(['重新连邮箱', '晚点']);
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '重新连邮箱' }));
    expect(await screen.findByRole('dialog', { name: '连邮箱' })).toBeInTheDocument();
    expect(apiPostJson).not.toHaveBeenCalled();
  });
});

describe('连邮箱浮层（F6）', () => {
  it('浮层开着按 Esc：只关浮层，卡组还在；再按 Esc 才收起卡组', async () => {
    serve([mailAsk([BLOCKED])], [BLOCKED]);
    render(<WaitingDock />);
    const card = await openDeck();
    fireEvent.click(await within(actsOf(card)).findByRole('button', { name: '连邮箱' }));
    await screen.findByRole('dialog', { name: '连邮箱' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '连邮箱' })).toBeNull());
    expect(screen.getByTestId('waiting-deck')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('waiting-deck')).toBeNull());
  });
});

describe('一份申请的邮件往来', () => {
  it('发出的、对方来的、等你的那封各一行；等你的那封点了打开卡组定位到它', async () => {
    serve([mailAsk([REPLY], '京东 回信了')], [REPLY]);
    render(<MailThread thread={THREAD} />);
    const out = screen.getByTestId('thread-out-mm_out');
    expect(out).toHaveTextContent('投递邮件');
    expect(out).toHaveTextContent('北京邮电大学-周子航-信息管理-2027届.pdf');
    expect(within(out).queryByText(/想应聘贵司/)).toBeNull();
    fireEvent.click(within(out).getByRole('button', { name: '看正文' }));
    expect(within(out).getByText(/想应聘贵司/)).toBeInTheDocument();
    expect(screen.getByTestId('thread-in-mm_auto')).toHaveTextContent('自动回复');
    expect(screen.getByTestId('thread-in-mm_in')).toHaveTextContent('王莉 <wangli@jd.example>');
    const opened = vi.fn();
    const off = onEvent<{ id?: string }>(OPEN_DECK_EVENT, p => opened(p?.id));
    fireEvent.click(within(screen.getByTestId('thread-pending-mm_pending')).getByRole('button', { name: '看写好的回信 →' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(mailAsk([REPLY], '京东 回信了').id));
    off();
    expect(apiPostJson).not.toHaveBeenCalled();
  });
});
