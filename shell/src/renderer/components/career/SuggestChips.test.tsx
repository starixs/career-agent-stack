/**
 * 建议条（face-beta-polish；2026-11-05 改为一行三条：配合 / 犹豫 / 纠正）：小芽说完才出，说话时不出；点一下发出原话；
 * 输入框空着按 Tab 把第一条填进输入框；他打了字就收起；隐藏上下文不算他说的话。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { emitEvent } from '@/api/eventBus';
import { track } from '@/analytics';
import { careerApi } from './careerApi';
import { resetSuggestStore } from './suggestStore';
import { suggestToChat } from './CareerPrimitives';
import { runAskPrimary } from './delivery/askPrimary';
import { deliveryApi } from './delivery/deliveryApi';
import { requestOpenDeck } from './delivery/WaitingDock';
import { requestNavigation } from '@/features/career-shell/navModel';
import { CareerSuggestBar, visibleText } from './SuggestChips';
import type { Message } from '@/types/chat';
import { CAREER_SUGGEST_EVENT, type SuggestChip } from '../../../shared/careerSuggest';

const msg = (id: string, role: Message['role'], content: Message['content']): Message => ({ id, role, content, timestamp: new Date(0) });
const CHIPS: SuggestChip[] = [
  { text: '财务类', slot: 'act', mode: 'answer', kind: 'say', seed_id: null },
  { text: '再投 5 家', slot: 'next', mode: 'advance', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
];
/** 一行三条：配合 / 犹豫 / 纠正。 */
const THREE: SuggestChip[] = [
  { text: '就这 5 家', slot: 'next', mode: 'advance', stance: 'agree', kind: 'do', action: { type: 'start_card', card_id: 'c1', job_ids: ['j1'] }, seed_id: null },
  { text: '先不投，我去忙', slot: 'exit', mode: 'exit', stance: 'hesitate', kind: 'say', seed_id: null },
  { text: '换一批', slot: 'act', mode: 'answer', stance: 'correct', kind: 'do', action: { type: 'propose_batch' }, seed_id: null },
];

/** 兜底请求的回答（{ chips, scene }）。 */
function answer(chips: SuggestChip[], scene: string | null = 'S29') {
  vi.mocked(careerApi.suggest).mockResolvedValue({ chips, scene });
}

function mount(over: Record<string, unknown> = {}) {
  tabState.current = { messages: [msg('u1', 'user', '你好'), msg('a1', 'assistant', '你想先投哪类？')], isLoading: false, sessionState: 'idle', sessionId: 's1', ...over };
  const inputRef = createRef<HTMLTextAreaElement>();
  const view = render(<><CareerSuggestBar inputRef={inputRef} /><textarea ref={inputRef} aria-label="输入" /></>);
  return { ...view, input: screen.getByLabelText('输入') as HTMLTextAreaElement };
}

describe('建议条', () => {
  beforeEach(() => {
    resetSuggestStore();
    vi.mocked(track).mockReset();
    vi.mocked(careerApi.suggest).mockReset();
    answer(CHIPS);
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

  it('三条排成一行浮在输入框上沿：和输入框同宽、胶囊、不折行、按立场标记，第一条提示 Tab', async () => {
    answer(THREE);
    mount();
    const bar = await screen.findByTestId('career-suggest-chips');
    expect(bar.className).not.toMatch(/grid/);
    expect(bar.className).toMatch(/flex-nowrap/);
    expect(bar.className).toMatch(/max-w-\[828px\]/);
    expect(bar.className).toMatch(/overflow-x-auto/);
    // 压在输入区的渐变遮罩上面，不被洗淡
    expect(bar.className).toMatch(/\brelative\b/);
    const cells = within(bar).getAllByRole('button');
    expect(cells.map(c => c.dataset.stance)).toEqual(['agree', 'hesitate', 'correct']);
    for (const cell of cells) {
      expect(cell.querySelector('.truncate')).not.toBeNull();
      expect(cell.className).toMatch(/rounded-full/);
      // 和输入框同一分量：同底色、同阴影、同字号、墨色字
      expect(cell.className).toMatch(/shadow-md/);
      expect(cell.className).toMatch(/text-base/);
      expect(cell.className).toMatch(/text-\[var\(--ink\)\]/);
      expect(cell.className).toMatch(/pointer-events-auto/);
      expect(cell.querySelector('kbd')).toBeNull();
    }
    expect(cells[0].getAttribute('title')).toBe('就这 5 家（Tab 填入）');
    expect(cells[1].getAttribute('title')).toBe('先不投，我去忙');
    expect(cells[0].querySelector('svg')).not.toBeNull();
    expect(cells[1].querySelector('svg')).toBeNull();
  });

  it('do 类点了直接出表，不进对话', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /再投 5 家/ }));
    await waitFor(() => expect(careerApi.proposeBatch).toHaveBeenCalledTimes(1));
    expect(suggestToChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
  });

  it('↑ 进条、Enter 执行、Esc 回输入框', async () => {
    answer(THREE);
    const { input } = mount();
    const bar = await screen.findByTestId('career-suggest-chips');
    const cells = within(bar).getAllByRole('button');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[0]);
    fireEvent.keyDown(cells[0], { key: 'ArrowRight' });
    fireEvent.keyDown(cells[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[2]);
    fireEvent.keyDown(cells[2], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[2]);
    fireEvent.keyDown(cells[2], { key: 'Escape' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(cells[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(cells[0], { key: 'ArrowRight' });
    fireEvent.keyDown(cells[1], { key: 'ArrowRight' });
    fireEvent.keyDown(cells[2], { key: 'Enter' });
    await waitFor(() => expect(careerApi.proposeBatch).toHaveBeenCalledTimes(1));
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('ask_primary：点了就跑那件事的主动作，不只打开卡组', async () => {
    vi.mocked(runAskPrimary).mockReset().mockResolvedValue('resolved');
    answer([{ text: '备好的 3 家都投出', slot: 'next', mode: 'advance', kind: 'do', action: { type: 'ask_primary', ask_id: 'rev_1' }, seed_id: null }]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /备好的 3 家都投出/ }));
    await waitFor(() => expect(runAskPrimary).toHaveBeenCalledWith('rev_1'));
    expect(requestOpenDeck).not.toHaveBeenCalled();
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('fill 类填进输入框', async () => {
    answer([{ text: '我对城市有要求：', slot: 'shape', mode: 'option', kind: 'fill', seed_id: 'city' }]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /我对城市有要求/ }));
    expect(suggestToChat).toHaveBeenCalledWith('我对城市有要求：', undefined, 'prefill');
  });

  it('不认识的 action 退回发话', async () => {
    const odd = JSON.parse('{"text":"去火星","slot":"next","kind":"do","action":{"type":"fly_to_mars"},"seed_id":null}') as SuggestChip;
    answer([odd]);
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
    answer([
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
    answer([
      { text: '字节会深挖我简历哪里', slot: 'shape', mode: 'start', kind: 'do', action: { type: 'start_feature', feature_id: 'interview_predict', args: { company: '字节' } }, seed_id: null },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /字节会深挖/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('预测一下字节会深挖我简历哪里', expect.objectContaining({ surface: 'guide' }), 'send'));
  });

  it('start_feature 预填句冒号收尾：只填进输入框等他补', async () => {
    answer([
      { text: '丢个岗位给你看值不值得投', slot: 'shape', mode: 'start', kind: 'do', action: { type: 'start_feature', feature_id: 'job_evaluate' }, seed_id: null },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /值不值得投/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('帮我评估这个岗位，JD 是：', expect.objectContaining({ surface: 'guide' }), 'prefill'));
  });

  it('ask_choose：直接替他选，不发话', async () => {
    vi.mocked(deliveryApi.choose).mockReset().mockResolvedValue({});
    answer([
      { text: '选「接受调剂」', slot: 'act', mode: 'answer', kind: 'do', action: { type: 'ask_choose', ask_id: 'a1', choice: '接受调剂' }, seed_id: 's19_opt_0' },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /接受调剂/ }));
    await waitFor(() => expect(deliveryApi.choose).toHaveBeenCalledWith('a1', '接受调剂'));
    expect(suggestToChat).not.toHaveBeenCalled();
  });

  it('不在清单里的功能退回发话', async () => {
    const odd = JSON.parse('{"text":"开飞船","slot":"shape","mode":"start","kind":"do","action":{"type":"start_feature","feature_id":"spaceship"},"seed_id":null}') as SuggestChip;
    answer([odd]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /开飞船/ }));
    await waitFor(() => expect(suggestToChat).toHaveBeenCalledWith('开飞船'));
  });

  it('填空格：空看得见；点了预填，光标选中空', async () => {
    answer([{ text: '大概 __ 人参加：', slot: 'shape', mode: 'option', kind: 'fill', seed_id: null }]);
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

  describe('轮末推送（career:suggest）', () => {
    const fresh = () => [{ ...msg('u1', 'user', '你好'), timestamp: new Date() }, { ...msg('a1', 'assistant', '你想先投哪类？'), timestamp: new Date() }];
    const push = (over: Record<string, unknown> = {}) => emitEvent(CAREER_SUGGEST_EVENT, {
      sessionId: 's1', turn_id: 't1', assistant_message_id: 'a1', chips: THREE, scene: 'S13', source: 'hook', degraded: false, ts: Date.now(), ...over,
    });
    afterEach(() => { vi.useRealTimers(); });

    it('对得上最后一条消息：直接出三条，不再请求；埋点带 scene 和 source', async () => {
      push();
      mount({ messages: fresh() });
      expect(await screen.findByRole('button', { name: /换一批/ })).toBeInTheDocument();
      await act(async () => {});
      expect(careerApi.suggest).not.toHaveBeenCalled();
      expect(track).toHaveBeenCalledWith('career_suggest_shown', expect.objectContaining({ scene: 'S13', source: 'hook' }));
      fireEvent.click(screen.getByRole('button', { name: /先不投/ }));
      expect(track).toHaveBeenCalledWith('career_suggest_used', expect.objectContaining({ scene: 'S13', source: 'hook' }));
      expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
    });

    it('早到：id 对不上先不出，消息更新到这一条再出', async () => {
      vi.useFakeTimers();
      const { rerender } = mount({ messages: fresh().slice(0, 1) });
      push();
      await act(async () => {});
      expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
      tabState.current = { ...tabState.current, messages: fresh() };
      rerender(<><CareerSuggestBar inputRef={createRef()} /><textarea aria-label="输入" /></>);
      await act(async () => {});
      expect(screen.getByRole('button', { name: /换一批/ })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(careerApi.suggest).not.toHaveBeenCalled();
    });

    it('旧推送（ts 更早）不盖新的', async () => {
      push({ chips: CHIPS, ts: 2_000 });
      push({ chips: THREE, ts: 1_000 });
      mount({ messages: fresh() });
      expect(await screen.findByRole('button', { name: /财务类/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /换一批/ })).toBeNull();
    });

    it('别的会话的推送不认；宽限期过了兜底请求', async () => {
      vi.useFakeTimers();
      push({ sessionId: 's2' });
      mount({ messages: fresh() });
      await act(async () => { vi.advanceTimersByTime(3_700); });
      expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
      expect(careerApi.suggest).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(careerApi.suggest).toHaveBeenCalledWith(expect.objectContaining({
        source: 'poll', this_turn: { user: '你好', assistant: '你想先投哪类？', tools: [], cards: [] },
      }));
      expect(screen.getByRole('button', { name: /财务类/ })).toBeInTheDocument();
    });

    it('宽限期内推送到了：不再请求', async () => {
      vi.useFakeTimers();
      mount({ messages: fresh() });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      await act(async () => { push(); });
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(careerApi.suggest).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /换一批/ })).toBeInTheDocument();
    });

    it('初次打开（最后一条早就说完）：立刻请求', async () => {
      mount();
      await screen.findByTestId('career-suggest-chips');
      expect(careerApi.suggest).toHaveBeenCalledWith(expect.objectContaining({ source: 'poll' }));
    });

    it('推送没有格子（降级也空）：照样兜底请求', async () => {
      vi.useFakeTimers();
      push({ chips: [], degraded: true });
      mount({ messages: fresh() });
      await act(async () => { vi.advanceTimersByTime(3_800); });
      expect(careerApi.suggest).toHaveBeenCalledTimes(1);
    });

    it('小芽在说话时推送到了也不出', async () => {
      push();
      mount({ messages: fresh(), isLoading: true });
      await act(async () => {});
      expect(screen.queryByTestId('career-suggest-chips')).toBeNull();
    });
  });
});
