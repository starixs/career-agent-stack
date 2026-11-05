/**
 * 建议条（face-beta-polish）：小芽说完才出，说话时不出；点一下发出原话；
 * 输入框空着按 Tab 把第一条填进输入框；他打了字就收起；隐藏上下文不算他说的话。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabState = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@/context/TabContext', () => ({ useTabStateOptional: () => tabState.current }));
vi.mock('@/context/CareerCardsContext', () => ({ useCareerCards: () => ({ cards: [], setState: () => {} }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('./careerApi', () => ({ careerApi: { suggest: vi.fn() } }));
vi.mock('./CareerPrimitives', () => ({ suggestToChat: vi.fn() }));

import { careerApi } from './careerApi';
import { suggestToChat } from './CareerPrimitives';
import { CareerSuggestBar, visibleText } from './SuggestChips';
import type { Message } from '@/types/chat';

const msg = (id: string, role: Message['role'], content: Message['content']): Message => ({ id, role, content, timestamp: new Date(0) });
const CHIPS = [
  { text: '财务类', slot: 'reply' as const, seed_id: null },
  { text: '再投 5 家', slot: 'mainline' as const, seed_id: null },
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
  });

  it('说完才出；点一下发出原话', async () => {
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
});
