/**
 * 建议条（face-beta-polish）：小芽说完才出，说话时不出；点一下发出原话；
 * 输入框空着按 Tab 把第一条填进输入框；他打了字就收起；隐藏上下文不算他说的话。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabState = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@/context/TabContext', () => ({ useTabStateOptional: () => tabState.current }));
vi.mock('@/context/CareerCardsContext', () => ({ useCareerCards: () => ({ cards: [], setState: () => {} }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('./careerApi', () => ({ careerApi: { suggest: vi.fn(), proposeBatch: vi.fn(), startBatchPick: vi.fn(), dismissCard: vi.fn() } }));
vi.mock('./CareerPrimitives', () => ({ suggestToChat: vi.fn() }));
vi.mock('./delivery/WaitingDock', () => ({ requestOpenDeck: vi.fn() }));
vi.mock('./delivery/askPrimary', () => ({ runAskPrimary: vi.fn() }));

import { careerApi } from './careerApi';
import { suggestToChat } from './CareerPrimitives';
import { runAskPrimary } from './delivery/askPrimary';
import { requestOpenDeck } from './delivery/WaitingDock';
import { CareerSuggestBar, visibleText } from './SuggestChips';
import type { Message } from '@/types/chat';
import type { SuggestChip } from '../../../shared/careerSuggest';

const msg = (id: string, role: Message['role'], content: Message['content']): Message => ({ id, role, content, timestamp: new Date(0) });
const CHIPS: SuggestChip[] = [
  { text: '财务类', slot: 'act', kind: 'say', seed_id: null },
  { text: '再投 5 家', slot: 'next', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
];
const FOUR: SuggestChip[] = [
  { text: '全投，18 家都投', slot: 'act', kind: 'do', action: { type: 'start_card', card_id: 'c1', job_ids: ['j1', 'j2'] }, seed_id: null },
  { text: '换一批', slot: 'act', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
  { text: '就这 5 家', slot: 'next', kind: 'do', action: { type: 'start_card', card_id: 'c1', job_ids: ['j1'] }, seed_id: null },
  { text: '先不投，我去忙', slot: 'exit', kind: 'say', seed_id: null },
];

function mount(over: Record<string, unknown> = {}) {
  tabState.current = { messages: [msg('u1', 'user', '你好'), msg('a1', 'assistant', '你想先投哪类？')], isLoading: false, sessionState: 'idle', ...over };
  const inputRef = createRef<HTMLTextAreaElement>();
  const view = render(<><CareerSuggestBar inputRef={inputRef} /><textarea ref={inputRef} aria-label="输入" /></>);
  return { ...view, input: screen.getByLabelText('输入') as HTMLTextAreaElement };
}

describe('建议条', () => {
  beforeEach(() => {
    vi.mocked(careerApi.suggest).mockReset().mockResolvedValue(CHIPS);
    vi.mocked(suggestToChat).mockReset();
    vi.mocked(careerApi.proposeBatch).mockReset().mockResolvedValue({ posted: true, card_id: 'c2' });
    vi.mocked(careerApi.startBatchPick).mockReset();
  });

  it('说完才出；say 点一下发出原话', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /财务类/ }));
    expect(suggestToChat).toHaveBeenCalledWith('财务类');
    expect(careerApi.suggest).toHaveBeenCalledWith({ last_user: '你好', last_assistant: '你想先投哪类？', pending_cards: [] });
  });

  it('小芽在说话时不出', async () => {
    mount({ isLoading: true });
    await act(async () => {});
    expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
    expect(careerApi.suggest).not.toHaveBeenCalled();
  });

  it('输入框空着按 Tab：第一条填进输入框', async () => {
    const { input } = mount();
    await screen.findByTestId('career-suggest-chips');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(suggestToChat).toHaveBeenCalledWith('财务类', undefined, 'prefill');
  });

  it('他打了字就收起', async () => {
    const { input } = mount();
    await screen.findByTestId('career-suggest-chips');
    fireEvent.input(input, { target: { value: '我想' } });
    await waitFor(() => expect(screen.queryByTestId('career-suggest-chips')).toBeNull());
  });

  it('隐藏上下文不算他说的话', () => {
    expect(visibleText(msg('u', 'user', '<system-reminder>job_id=1</system-reminder>\n\n接着练'))).toBe('接着练');
    expect(visibleText(msg('a', 'assistant', [{ type: 'text', text: '好的' }]))).toBe('好的');
  });

  it('四条排成两列，不折行', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue(FOUR);
    mount();
    const bar = await screen.findByTestId('career-suggest-chips');
    expect(bar.className).toMatch(/grid-cols-2/);
    expect(bar.className).toMatch(/gap-1\.5/);
    const cells = within(bar).getAllByRole('button');
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.querySelector('.truncate')).not.toBeNull();
      expect(cell.getAttribute('title')).toBeTruthy();
      expect(cell.className).toMatch(/rounded-lg/);
      expect(cell.className).not.toMatch(/rounded-full/);
    }
    expect(cells[3].className).toMatch(/border-transparent/);
    expect(cells[3].className).toMatch(/text-\[var\(--muted\)\]/);
    expect(cells[0].querySelector('svg')).not.toBeNull();
    expect(cells[3].querySelector('svg')).toBeNull();
  });

  it('两条一行', async () => {
    mount();
    const bar = await screen.findByTestId('career-suggest-chips');
    expect(bar.className).not.toMatch(/grid/);
    expect(bar.className).toMatch(/flex-nowrap/);
  });

  it('do 类点了直接出表，不进对话', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /再投 5 家/ }));
    await waitFor(() => expect(careerApi.proposeBatch).toHaveBeenCalledTimes(1));
    expect(suggestToChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
  });

  it('↑ 进条、Enter 执行、Esc 回输入框', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue(FOUR);
    const { input } = mount();
    const bar = await screen.findByTestId('career-suggest-chips');
    const cells = within(bar).getAllByRole('button');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[0]);
    fireEvent.keyDown(cells[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells[2]);
    fireEvent.keyDown(cells[2], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[3]);
    fireEvent.keyDown(cells[3], { key: 'Escape' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(cells[0], { key: 'ArrowRight' });
    fireEvent.keyDown(cells[1], { key: 'Enter' });
    await waitFor(() => expect(careerApi.proposeBatch).toHaveBeenCalledTimes(1));
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('ask_primary：点了就跑那件事的主动作，不只打开卡组', async () => {
    vi.mocked(runAskPrimary).mockReset().mockResolvedValue('resolved');
    vi.mocked(careerApi.suggest).mockResolvedValue([{ text: '备好的 3 家都投出', slot: 'next', kind: 'do', action: { type: 'ask_primary', ask_id: 'rev_1' }, seed_id: null }]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /备好的 3 家都投出/ }));
    await waitFor(() => expect(runAskPrimary).toHaveBeenCalledWith('rev_1'));
    expect(requestOpenDeck).not.toHaveBeenCalled();
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('fill 类填进输入框', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue([{ text: '我对城市有要求：', slot: 'shape', kind: 'fill', seed_id: 'city' }]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /我对城市有要求/ }));
    expect(suggestToChat).toHaveBeenCalledWith('我对城市有要求：', undefined, 'prefill');
  });

  it('不认识的 action 退回发话', async () => {
    const odd = JSON.parse('{"text":"去火星","slot":"next","kind":"do","action":{"type":"fly_to_mars"},"seed_id":null}') as SuggestChip;
    vi.mocked(careerApi.suggest).mockResolvedValue([odd]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /去火星/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('去火星'));
    expect(careerApi.proposeBatch).not.toHaveBeenCalled();
  });
});
