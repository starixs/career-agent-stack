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
vi.mock('./delivery/deliveryApi', () => ({ deliveryApi: { choose: vi.fn() } }));
vi.mock('./BatchPickCard', () => ({ openBatchPick: vi.fn() }));
vi.mock('@/features/career-shell/navModel', () => ({ JOB_BOARD_TARGET: { kind: 'career-jobs' }, requestNavigation: vi.fn() }));

import { careerApi } from './careerApi';
import { suggestToChat } from './CareerPrimitives';
import { runAskPrimary } from './delivery/askPrimary';
import { deliveryApi } from './delivery/deliveryApi';
import { requestOpenDeck } from './delivery/WaitingDock';
import { requestNavigation } from '@/features/career-shell/navModel';
import { CareerSuggestBar, visibleText } from './SuggestChips';
import type { Message } from '@/types/chat';
import type { SuggestChip } from '../../../shared/careerSuggest';

const msg = (id: string, role: Message['role'], content: Message['content']): Message => ({ id, role, content, timestamp: new Date(0) });
const CHIPS: SuggestChip[] = [
  { text: '财务类', slot: 'act', mode: 'answer', kind: 'say', seed_id: null },
  { text: '再投 5 家', slot: 'next', mode: 'advance', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
];
const FOUR: SuggestChip[] = [
  { text: '全投，18 家都投', slot: 'act', mode: 'answer', kind: 'do', action: { type: 'start_card', card_id: 'c1', job_ids: ['j1', 'j2'] }, seed_id: null },
  { text: '换一批', slot: 'act', mode: 'answer', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
  { text: '就这 5 家', slot: 'next', mode: 'advance', kind: 'do', action: { type: 'start_card', card_id: 'c1', job_ids: ['j1'] }, seed_id: null },
  { text: '先不投，我去忙', slot: 'exit', mode: 'exit', kind: 'say', seed_id: null },
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
    expect(careerApi.suggest).toHaveBeenCalledWith(expect.objectContaining({ last_user: '你好', last_assistant: '你想先投哪类？', pending_cards: [] }));
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
    vi.mocked(careerApi.suggest).mockResolvedValue([{ text: '备好的 3 家都投出', slot: 'next', mode: 'advance', kind: 'do', action: { type: 'ask_primary', ask_id: 'rev_1' }, seed_id: null }]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /备好的 3 家都投出/ }));
    await waitFor(() => expect(runAskPrimary).toHaveBeenCalledWith('rev_1'));
    expect(requestOpenDeck).not.toHaveBeenCalled();
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('fill 类填进输入框', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue([{ text: '我对城市有要求：', slot: 'shape', mode: 'option', kind: 'fill', seed_id: 'city' }]);
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

  it('请求带最近 6 轮可见文字、上一轮用过的工具、隔了几小时', async () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * 3_600_000);
    const tool = (name: string) => ({ type: 'tool_use' as const, tool: { id: name, name, input: {}, streamIndex: 0 } });
    const messages: Message[] = [
      { ...msg('u0', 'user', '最早一句'), timestamp: at(0) },
      { ...msg('a0', 'assistant', [tool('mcp__career__job_search'), { type: 'text', text: '找到了' }]), timestamp: at(0) },
      ...['一', '二', '三'].flatMap((t, i) => [msg(`ux${i}`, 'user', t), msg(`ax${i}`, 'assistant', `回${t}`)]).map(m => ({ ...m, timestamp: at(1) })),
      { ...msg('u9', 'user', '<system-reminder>ctx</system-reminder>\n\n我回来了'), timestamp: at(49.5) },
      { ...msg('a9', 'assistant', [tool('mcp__career__experience_interview'), { type: 'text', text: '欢迎回来' }, tool('mcp__career__experience_interview'), tool('Read')]), timestamp: at(49.5) },
    ];
    mount({ messages });
    await screen.findByTestId('career-suggest-chips');
    const body = vi.mocked(careerApi.suggest).mock.calls[0][0];
    expect(body.turns).toEqual([
      { role: 'user', text: '二' }, { role: 'assistant', text: '回二' }, { role: 'user', text: '三' }, { role: 'assistant', text: '回三' },
      { role: 'user', text: '我回来了' }, { role: 'assistant', text: '欢迎回来' },
    ]);
    expect(body.last_tools).toEqual(['experience_interview']);
    expect(body.away_hours).toBe(48.5);
  });

  it('只说过一句：away_hours 为 null', async () => {
    mount({ messages: [msg('u1', 'user', '你好')] });
    await screen.findByTestId('career-suggest-chips');
    expect(vi.mocked(careerApi.suggest).mock.calls[0][0].away_hours).toBeNull();
  });

  it('start_feature：和功能市场那张卡同一个起头，不发话', async () => {
    vi.mocked(requestNavigation).mockReset();
    vi.mocked(careerApi.suggest).mockResolvedValue([
      { text: '考试时截图给你搜题', slot: 'shape', mode: 'start', kind: 'do', action: { type: 'start_feature', feature_id: 'exam_search' }, seed_id: null },
    ]);
    mount();
    const exam = await screen.findByRole('button', { name: /截图给你搜题/ });
    expect(exam.querySelector('svg')).not.toBeNull();
    fireEvent.click(exam);
    await waitFor(() => expect(requestNavigation).toHaveBeenCalledWith({ kind: 'career-dossier', view: 'exam-search' }));
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('start_feature 带公司：句子完整，点名后直接发出', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue([
      { text: '字节会深挖我简历哪里', slot: 'shape', mode: 'start', kind: 'do', action: { type: 'start_feature', feature_id: 'interview_predict', args: { company: '字节' } }, seed_id: null },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /字节会深挖/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('预测一下字节会深挖我简历哪里', expect.objectContaining({ surface: 'guide' }), 'send'));
  });

  it('start_feature 预填句冒号收尾：只填进输入框等他补', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue([
      { text: '丢个岗位给你看值不值得投', slot: 'shape', mode: 'start', kind: 'do', action: { type: 'start_feature', feature_id: 'job_evaluate' }, seed_id: null },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /值不值得投/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('帮我评估这个岗位，JD 是：', expect.objectContaining({ surface: 'guide' }), 'prefill'));
  });

  it('ask_choose：直接替他选，不发话', async () => {
    vi.mocked(deliveryApi.choose).mockReset().mockResolvedValue({});
    vi.mocked(careerApi.suggest).mockResolvedValue([
      { text: '选「接受调剂」', slot: 'act', mode: 'answer', kind: 'do', action: { type: 'ask_choose', ask_id: 'a1', choice: '接受调剂' }, seed_id: 's19_opt_0' },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /接受调剂/ }));
    await waitFor(() => expect(deliveryApi.choose).toHaveBeenCalledWith('a1', '接受调剂'));
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('不在清单里的功能退回发话', async () => {
    const odd = JSON.parse('{"text":"开飞船","slot":"shape","mode":"start","kind":"do","action":{"type":"start_feature","feature_id":"spaceship"},"seed_id":null}') as SuggestChip;
    vi.mocked(careerApi.suggest).mockResolvedValue([odd]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /开飞船/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('开飞船'));
  });

  it('填空格：空看得见；点了预填，光标选中空', async () => {
    vi.mocked(careerApi.suggest).mockResolvedValue([{ text: '大概 __ 人参加：', slot: 'shape', mode: 'option', kind: 'fill', seed_id: null }]);
    const { input } = mount();
    vi.mocked(suggestToChat).mockImplementation((text: string) => { input.value = text; });
    const cell = await screen.findByRole('button', { name: /人参加/ });
    expect(cell).toHaveTextContent('大概 ＿＿ 人参加：');
    expect(cell.querySelector('[data-blank]')).not.toBeNull();
    expect(cell.getAttribute('data-mode')).toBe('option');
    fireEvent.click(cell);
    expect(suggestToChat).toHaveBeenCalledWith('大概 ＿＿ 人参加：', undefined, 'prefill');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
  });
});
