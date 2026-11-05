/**
 * 建议条（face-beta-polish 2026-11-05 你定）：输入框正上方一行，最多四个小框。
 *
 * 点一下 = 直接发出；输入框空着时按 Tab = 把第一条填进输入框可改（Tab 由输入框转给这里，见 fillFirstSuggestion）。
 * 他一打字、小芽在说话时都不出现；放不下的不折行，直接不显示。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { track } from '@/analytics';
import { useCareerCards } from '@/context/CareerCardsContext';
import { useTabStateOptional } from '@/context/TabContext';
import type { Message } from '@/types/chat';

import { careerApi } from './careerApi';
import { suggestToChat } from './CareerPrimitives';
import type { SuggestChip, SuggestRequest } from '../../../shared/careerSuggest';

export function SuggestChips({ chips, onSend }: { chips: SuggestChip[]; onSend: (chip: SuggestChip) => void }) {
  if (!chips.length) return null;
  return (
    <div data-testid="career-suggest-chips" role="group" aria-label="可以这样回" className="flex flex-nowrap items-center gap-2 overflow-hidden px-1 pb-2">
      {chips.map((c, i) => (
        <button
          key={`${c.slot}:${c.text}`} type="button" onClick={() => onSend(c)}
          className="shrink-0 whitespace-nowrap rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-3 py-1 text-sm text-[var(--ink-2)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
        >
          {c.text}
          {i === 0 && <kbd className="ml-1.5 align-middle font-sans text-xs text-[var(--subtle)]" aria-label="按 Tab 填入">Tab</kbd>}
        </button>
      ))}
    </div>
  );
}

/** 一轮说完后去取建议。`turnKey` 变了（新的一轮说完）才重新取；在说话时、或结果不属于这一轮时不显示。 */
export function useCareerSuggestions({ enabled, streaming, turnKey, request }: {
  enabled: boolean;
  streaming: boolean;
  /** 最后一条消息的 id：变了说明有新的一轮。 */
  turnKey: string | null;
  request: () => SuggestRequest;
}) {
  const [got, setGot] = useState<{ key: string | null; chips: SuggestChip[] }>({ key: null, chips: [] });
  const requestRef = useRef(request);
  // 只要最新的取法，不让它驱动重取：重取只跟着新的一轮（turnKey）走
  useEffect(() => { requestRef.current = request; });
  useEffect(() => {
    if (!enabled || streaming) return;
    let alive = true;
    careerApi.suggest(requestRef.current())
      .then(next => {
        if (!alive) return;
        setGot({ key: turnKey, chips: next });
        if (next.length) track('career_suggest_shown', { slots: next.map(c => c.slot).join(',') });
      })
      .catch((error: unknown) => console.warn('[career-suggest] fetch failed:', error instanceof Error ? error.message : error));
    return () => { alive = false; };
  }, [enabled, streaming, turnKey]);
  const used = useCallback((chip: SuggestChip, how: 'click' | 'tab') => {
    track('career_suggest_used', { slot: chip.slot, seed_id: chip.seed_id ?? '', how });
    setGot({ key: null, chips: [] });
  }, []);
  const chips = enabled && !streaming && got.key === turnKey ? got.chips : [];
  return { chips, used };
}

/** 隐藏上下文（system-reminder）不算他说的话。 */
const HIDDEN_CONTEXT = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** 一条消息里给人看的文字。 */
export function visibleText(message: Message | undefined): string {
  if (!message) return '';
  const raw = typeof message.content === 'string'
    ? message.content
    : message.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  return raw.replace(HIDDEN_CONTEXT, '').trim();
}

const lastOf = (messages: readonly Message[], role: Message['role']): Message | undefined => [...messages].reverse().find(m => m.role === role);

/**
 * 放在输入框上沿（等你条下面）的建议条：自取 TabState，和等你条一样 slot 恒定，不打穿输入框的 memo。
 * 点一下 = 直接发出（career:chat-suggest send）；输入框空着按 Tab = 第一条填进输入框（prefill）。
 * 他在这一轮打了字就收起；发出去以后有了新消息，就是新的一轮，再出来。
 */
export function CareerSuggestBar({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const tab = useTabStateOptional();
  const { cards } = useCareerCards();
  const messages = tab?.messages ?? [];
  const streaming = !!tab && (tab.isLoading || tab.sessionState === 'running' || tab.sessionState === 'starting');
  const turnKey = messages.at(-1)?.id ?? 'empty';
  const [typedAt, setTypedAt] = useState<string | null>(null);
  const keyRef = useRef(turnKey);
  useEffect(() => { keyRef.current = turnKey; });
  const pending = cards.filter(c => (c.state ?? 'pending') === 'pending').map(c => c.kind);
  const { chips, used } = useCareerSuggestions({
    enabled: !!tab,
    streaming,
    turnKey,
    request: () => ({ last_user: visibleText(lastOf(messages, 'user')), last_assistant: visibleText(lastOf(messages, 'assistant')), pending_cards: pending }),
  });
  const visible = typedAt === turnKey ? [] : chips;
  const chipsRef = useRef(visible);
  useEffect(() => { chipsRef.current = visible; });
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onInput = () => setTypedAt(el.value.trim() ? keyRef.current : null);
    const onKey = (e: KeyboardEvent) => {
      const first = chipsRef.current[0];
      if (e.key !== 'Tab' || e.shiftKey || el.value.trim() || !first) return;
      e.preventDefault();
      suggestToChat(first.text, undefined, 'prefill');
      used(first, 'tab');
    };
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); };
  }, [inputRef, used]);
  return <SuggestChips chips={visible} onSend={chip => { used(chip, 'click'); suggestToChat(chip.text); }} />;
}
