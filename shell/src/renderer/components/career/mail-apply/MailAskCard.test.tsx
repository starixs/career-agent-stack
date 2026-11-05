/**
 * 邮件投递 · 发前过目（face-mail-apply §3.2、§3.4）：等你条卡组里「邮件写好了」这一张。
 * 一封：大海报 + 整封邮件；几封：左边可勾选的行（默认全勾）；还差东西时主按钮不可点或变「连邮箱」。
 * 数据按 shared/careerMailApply.ts 合同造（testFixtures.ts），接口用 apiFetch 替身。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';

import type { MailDraftView } from '../../../../shared/careerMailApply';
import { runAskPrimary } from '../delivery/askPrimary';
import type { AskView } from '../delivery/deliveryApi';
import { OPEN_DECK_EVENT } from '../delivery/ReturnCard';
import { goAsk } from '../delivery/useAskActions';
import { WaitingDock } from '../delivery/WaitingDock';
import { BLOCKED, draft, mailAsk, MULTI, SINGLE } from './testFixtures';

const REVIEW = '/api/career/actions/review';
const DRAFTS = '/api/career/mail-apply/drafts';

/** 服务端替身：等你条拿 asks，卡片按 ids 取邮件预览。 */
function serve(asks: AskView[], drafts: MailDraftView[]) {
  vi.mocked(apiGetJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/career/asks')) return { ok: true, asks, run: null };
    if (url.startsWith(DRAFTS)) {
      const ids = decodeURIComponent(url.split('ids=')[1] ?? '').split(',');
      return { ok: true, drafts: drafts.filter(d => ids.includes(d.action_id)) };
    }
    return { ok: true };
  });
}

/** 打开卡组，等邮件取回来（不在「正在取邮件」上断言）。 */
async function openDeck() {
  fireEvent.click(await screen.findByRole('button', { name: /等你\s*1/ }));
  await screen.findByTestId('ask-card-mail');
  await waitFor(() => expect(screen.queryByText('正在取邮件…')).toBeNull());
  return screen.getByTestId('ask-card-mail');
}

const actsOf = (card: HTMLElement) => card.querySelector<HTMLElement>('.cd-acts')!;

describe('邮件写好了 · 发前过目', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
  });

  it('一封：左边公司大海报，右边收件人 / 标题 / 正文 / 附件都在，两个动作「发出 · 不投这家」，没有规则说明', async () => {
    serve([mailAsk([SINGLE])], [SINGLE]);
    render(<WaitingDock />);
    const card = await openDeck();
    expect(within(card).getByTestId('company-poster')).toHaveAttribute('title', '美团 · 产品运营实习生');
    expect(await within(card).findByLabelText('收件人')).toHaveValue(SINGLE.to);
    expect(within(card).getByLabelText('标题')).toHaveValue(SINGLE.subject);
    expect(within(card).getByLabelText('正文')).toHaveValue(SINGLE.body);
    expect(within(card).getByRole('button', { name: `看附件 ${SINGLE.attachments[0].filename}` })).toHaveTextContent('按岗位改了 4 处');
    expect(within(card).getByText('zhouzihang@qq.com')).toBeInTheDocument();
    expect(within(actsOf(card)).getAllByRole('button').map(b => b.textContent)).toEqual(['发出', '不投这家']);
    expect(within(card).queryByText(/撤不回|只存本机|发出后/)).toBeNull();
    expect(within(card).queryByTestId('mail-availability')).toBeNull();
  });

  it('一封点「发出」：批准这一封的 send_mail，这件从卡组里拿走；「不投这家」带 drop', async () => {
    serve([mailAsk([SINGLE])], [SINGLE]);
    render(<WaitingDock />);
    const card = await openDeck();
    await within(card).findByLabelText('收件人');
    serve([], []);
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '发出' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_mt'], decision: 'approved' }));
    await waitFor(() => expect(screen.queryByTestId('waiting-deck')).toBeNull());
  });

  it('「不投这家」= 拒绝并把申请标成跳过', async () => {
    serve([mailAsk([SINGLE])], [SINGLE]);
    render(<WaitingDock />);
    const card = await openDeck();
    await within(card).findByLabelText('收件人');
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '不投这家' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_mt'], decision: 'rejected', drop: true }));
  });

  it('三封：默认全勾「发出 3 封」，取消一行变 2 封；点第二行右边换成那一封；只发勾的，发完的行走掉、卡还在', async () => {
    serve([mailAsk(MULTI)], MULTI);
    render(<WaitingDock />);
    const card = await openDeck();
    const acts = actsOf(card);
    expect(await within(acts).findByRole('button', { name: '发出 3 封' })).toBeEnabled();
    expect(within(acts).getByRole('button', { name: '先收起' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('checkbox', { name: '发 大疆 · 市场策划实习生' }));
    expect(within(acts).getByRole('button', { name: '发出 2 封' })).toBeEnabled();
    expect(within(card).getByTestId('mail-sheet-m_jd')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /美团/ }));
    expect(within(card).getByTestId('mail-sheet-m_mt')).toBeInTheDocument();
    expect(within(card).getByLabelText('收件人')).toHaveValue('campus-ops@meituan.example');
    fireEvent.click(within(acts).getByRole('button', { name: '发出 2 封' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_jd', 'm_mt'], decision: 'approved' }));
    await waitFor(() => expect(within(card).queryByTestId('mail-row-m_mt')).toBeNull());
    expect(screen.getByTestId('waiting-deck')).toBeInTheDocument();
    expect(within(card).getByTestId('mail-sheet-m_dj')).toBeInTheDocument();
  });

  it('Shift 点连选：从第一行连到第三行一起取消，按钮变灰', async () => {
    serve([mailAsk(MULTI)], MULTI);
    render(<WaitingDock />);
    const card = await openDeck();
    await within(card).findByRole('button', { name: '发出 3 封' });
    fireEvent.click(within(card).getByRole('checkbox', { name: '发 京东 · 用户运营实习生' }));
    fireEvent.click(within(card).getByRole('checkbox', { name: '发 大疆 · 市场策划实习生' }), { shiftKey: true });
    expect(within(actsOf(card)).getByRole('button', { name: '发出 0 封' })).toBeDisabled();
  });

  it('实习到岗没说：顶上三组点选，主按钮不可点；点满即存，用返回的预览刷新，按钮可点', async () => {
    const waiting = draft({ action_id: 'm_av', company: '京东', role: '数据运营实习生', blockers: ['availability'], availability: { days_per_week: null, months: null, start: null } });
    serve([mailAsk([waiting])], [waiting]);
    vi.mocked(apiPostJson).mockImplementation(async (url: string) => (url.endsWith('/availability')
      ? { ok: true, drafts: [{ ...waiting, blockers: [], availability: { days_per_week: '4', months: '6', start: '两周内' } }] }
      : { ok: true }));
    render(<WaitingDock />);
    const card = await openDeck();
    const row = await within(card).findByTestId('mail-availability');
    expect(within(actsOf(card)).getByRole('button', { name: '发出' })).toBeDisabled();
    fireEvent.click(within(within(row).getByRole('radiogroup', { name: '每周' })).getByRole('radio', { name: '4 天' }));
    fireEvent.click(within(within(row).getByRole('radiogroup', { name: '实习' })).getByRole('radio', { name: '6 个月' }));
    expect(apiPostJson).not.toHaveBeenCalled();
    fireEvent.click(within(within(row).getByRole('radiogroup', { name: '到岗' })).getByRole('radio', { name: '两周内' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/mail-apply/availability', { days_per_week: '4', months: '6', start: '两周内' }));
    await waitFor(() => expect(within(actsOf(card)).getByRole('button', { name: '发出' })).toBeEnabled());
    expect(within(card).queryByTestId('mail-availability')).toBeNull();
  });

  it('没连邮箱：主按钮是「连邮箱」，点了打开现有的邮箱连接', async () => {
    serve([mailAsk([BLOCKED])], [BLOCKED]);
    render(<WaitingDock />);
    const card = await openDeck();
    const go = await within(actsOf(card)).findByRole('button', { name: '连邮箱' });
    expect(within(card).queryByText('发件')).toBeNull();
    fireEvent.click(go);
    expect(await screen.findByRole('dialog', { name: '连邮箱' })).toBeInTheDocument();
    await waitFor(() => expect(apiGetJson).toHaveBeenCalledWith('/api/career/mail/connectors'));
  });

  it('改正文失焦才存；存不上在那一格下面说原因，打的字留着', async () => {
    serve([mailAsk([SINGLE])], [SINGLE]);
    vi.mocked(apiPostJson).mockImplementation(async (url: string, body: unknown) => {
      if (url === `${DRAFTS}/m_mt`) {
        if (JSON.stringify(body).includes('失败')) throw new Error('网络断了，没存上');
        return { ok: true, draft: { ...SINGLE, ...(body && typeof body === 'object' ? body : {}) } };
      }
      return { ok: true };
    });
    render(<WaitingDock />);
    const card = await openDeck();
    const text = await within(card).findByLabelText('正文');
    fireEvent.change(text, { target: { value: `${SINGLE.body}\n\n附：作品集链接` } });
    expect(apiPostJson).not.toHaveBeenCalled();
    fireEvent.blur(text);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(`${DRAFTS}/m_mt`, { body: `${SINGLE.body}\n\n附：作品集链接` }));
    fireEvent.change(text, { target: { value: '这次会失败' } });
    fireEvent.blur(text);
    expect(await within(card).findByRole('alert')).toHaveTextContent('网络断了，没存上');
    expect(text).toHaveValue('这次会失败');
  });

  it('收件人不对：那一格标红（aria-invalid），发出不可点', async () => {
    const bad = { ...SINGLE, to: 'zhouzihang@qq.com', blockers: ['bad_recipient' as const] };
    serve([mailAsk([bad])], [bad]);
    render(<WaitingDock />);
    const card = await openDeck();
    expect(await within(card).findByLabelText('收件人')).toHaveAttribute('aria-invalid', 'true');
    expect(within(card).getByLabelText('标题')).toHaveAttribute('aria-invalid', 'false');
    expect(within(actsOf(card)).getByRole('button', { name: '发出' })).toBeDisabled();
  });

  it('键盘可达：Tab 到勾选框空格取消、到行上回车切过去；在正文里按 ← → 不翻卡', async () => {
    const user = userEvent.setup();
    serve([mailAsk(MULTI)], MULTI);
    render(<WaitingDock />);
    const card = await openDeck();
    await within(card).findByRole('button', { name: '发出 3 封' });
    const box = within(card).getByRole('checkbox', { name: '发 京东 · 用户运营实习生' });
    box.focus();
    await user.keyboard(' ');
    expect(within(actsOf(card)).getByRole('button', { name: '发出 2 封' })).toBeInTheDocument();
    await user.tab(); // 京东那行
    await user.tab(); // 美团的勾选框
    await user.tab(); // 美团那行
    expect(document.activeElement).toHaveTextContent('美团');
    await user.keyboard('{Enter}');
    expect(within(card).getByTestId('mail-sheet-m_mt')).toBeInTheDocument();
    within(card).getByLabelText('正文').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('ask-card-mail')).toBe(card);
  });

  it('跟进信：「发出 · 不跟了」，不跟了只拒绝这封、不把申请标成跳过', async () => {
    const follow = draft({ action_id: 'm_fu', company: '大疆', role: '市场策划实习生', purpose: 'followup', thread: { subject: '应聘市场策划实习生', sent_at: '2026-10-29T02:00:00.000Z' } });
    serve([mailAsk([follow], '大疆 · 一周没回音')], [follow]);
    render(<WaitingDock />);
    const card = await openDeck();
    expect(await within(card).findByText('接着 10月29日 那封')).toBeInTheDocument();
    fireEvent.click(within(actsOf(card)).getByRole('button', { name: '不跟了' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith(REVIEW, { ids: ['m_fu'], decision: 'rejected' }));
  });
});

describe('卡组外的入口：不看预览不发（F4）', () => {
  beforeEach(() => {
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('建议条点邮件那件：都不差东西也只打开卡组定位到它，没有调用发出', async () => {
    serve([mailAsk(MULTI)], MULTI);
    const opened = vi.fn();
    const off = onEvent<{ id?: string }>(OPEN_DECK_EVENT, p => opened(p?.id));
    await expect(runAskPrimary(mailAsk(MULTI).id)).resolves.toBe('deck');
    off();
    expect(opened).toHaveBeenCalledWith(mailAsk(MULTI).id);
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('有一封还差东西：同样只打开卡组，一封也不发', async () => {
    const list = [MULTI[0], { ...MULTI[1], blockers: ['bad_recipient' as const] }];
    serve([mailAsk(list)], list);
    await expect(runAskPrimary(mailAsk(list).id)).resolves.toBe('deck');
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('卡组主按钮那条路（goAsk）遇到邮件也只打开卡组', async () => {
    const opened = vi.fn();
    const off = onEvent<{ id?: string }>(OPEN_DECK_EVENT, p => opened(p?.id));
    const respond = vi.fn(async () => true);
    await expect(goAsk(mailAsk([SINGLE]), respond, {})).resolves.toBe('kept');
    off();
    expect(respond).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledWith(mailAsk([SINGLE]).id);
  });
});
