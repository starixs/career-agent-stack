/**
 * 建议条（face-beta-polish 2026-11-05 你定；版式 plan-r2 §B.5）：输入框正上方，最多四格。
 *
 * 3–4 条排成两列、1–2 条一行；每格单行，放不下截断（悬停看全文）。
 * 点一下或 Enter = 执行（say 发出、fill 填入、do 直接办，见 suggestActions.ts）；
 * 输入框空着：Tab 把第一条填进输入框，↑ 进条，方向键在格间走，Esc 回输入框。
 * 他一打字、小芽在说话时都不出现。
 */
import { Eye, LogIn, Send, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { useCareerCards } from '@/context/CareerCardsContext';
import { useTabStateOptional } from '@/context/TabContext';

import { suggestToChat } from './CareerPrimitives';
import { runSuggestion } from './suggestActions';
import { lastOf, useCareerSuggestions, visibleText } from './useCareerSuggestions';
import type { SuggestAction, SuggestChip } from '../../../shared/careerSuggest';

export { visibleText } from './useCareerSuggestions';

/** 几条起排成两列（plan-r2 §B.5）。 */
const GRID_FROM = 3;
const GRID_COLS = 2;

const ICONS: Partial<Record<SuggestAction['type'], LucideIcon>> = {
  propose_batch: Send, start_card: Send, ask_primary: Send, open_deck: LogIn, open: Eye,
};

const CELL = 'flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]';
const BOXED = 'border border-[var(--line-2)] bg-[var(--paper)] text-[var(--ink-2)] hover:border-[var(--ink)] hover:text-[var(--ink)]';
const BARE = 'border border-transparent text-[var(--muted)] hover:text-[var(--ink)]';

/** 方向键在格间走：两列时上下跨一行，一行时只左右。 */
function nextIndex(key: string, i: number, n: number): number | null {
  const cols = n >= GRID_FROM ? GRID_COLS : n;
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -cols : key === 'ArrowDown' ? cols : 0;
  if (!step) return null;
  const to = i + step;
  return to >= 0 && to < n ? to : i;
}

export function SuggestChips({ chips, onSend, onEscape, barRef }: {
  chips: SuggestChip[];
  onSend: (chip: SuggestChip, how: 'click' | 'key') => void;
  onEscape?: () => void;
  barRef?: RefObject<HTMLDivElement | null>;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!chips.length) return null;
  const grid = chips.length >= GRID_FROM;
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); return; }
    if (e.key === 'Enter') { e.preventDefault(); onSend(chips[i], 'key'); return; }
    const to = nextIndex(e.key, i, chips.length);
    if (to === null) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  return (
    <div
      ref={barRef} data-testid="career-suggest-chips" role="group" aria-label="可以这样回"
      className={`w-full pb-2 ${grid ? 'grid grid-cols-2 gap-1.5' : 'flex flex-nowrap gap-1.5 overflow-hidden'}`}
    >
      {chips.map((c, i) => {
        const Icon = c.kind === 'do' && c.action ? ICONS[c.action.type] : undefined;
        return (
          <button
            key={`${c.slot}:${c.text}`} ref={el => { refs.current[i] = el; }} type="button" title={c.text}
            data-slot={c.slot} data-kind={c.kind}
            onClick={() => onSend(c, 'click')} onKeyDown={e => onKey(e, i)}
            className={`${CELL} ${c.slot === 'exit' ? BARE : BOXED} ${grid ? '' : 'max-w-full shrink'}`}
          >
            {Icon && <Icon size={12} aria-hidden className="shrink-0" />}
            <span className="min-w-0 truncate">{c.text}</span>
            {i === 0 && <kbd className="ml-auto shrink-0 pl-1 font-sans text-xs text-[var(--subtle)]" aria-label="按 Tab 填入">Tab</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** 输入框的键：空着时 Tab 填第一条、↑ 进条。 */
function useInputKeys(inputRef: RefObject<HTMLTextAreaElement | null>, barRef: RefObject<HTMLDivElement | null>, chips: SuggestChip[], onTab: (chip: SuggestChip) => void, onTyped: (typed: boolean) => void) {
  const chipsRef = useRef(chips);
  const onTabRef = useRef(onTab);
  const onTypedRef = useRef(onTyped);
  useEffect(() => { chipsRef.current = chips; onTabRef.current = onTab; onTypedRef.current = onTyped; });
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onInput = () => onTypedRef.current(!!el.value.trim());
    const onKey = (e: KeyboardEvent) => {
      const first = chipsRef.current[0];
      if (e.shiftKey || el.value.trim() || !first) return;
      if (e.key === 'Tab') { e.preventDefault(); onTabRef.current(first); return; }
      if (e.key !== 'ArrowUp') return;
      const cell = barRef.current?.querySelector('button');
      if (!cell) return;
      e.preventDefault();
      cell.focus();
    };
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); };
  }, [inputRef, barRef]);
}

/**
 * 放在输入框上沿（等你条下面）的建议条：自取 TabState，和等你条一样 slot 恒定，不打穿输入框的 memo。
 * 他在这一轮打了字就收起；发出去以后有了新消息，就是新的一轮，再出来。
 */
export function CareerSuggestBar({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const tab = useTabStateOptional();
  const { cards } = useCareerCards();
  const messages = tab?.messages ?? [];
  const streaming = !!tab && (tab.isLoading || tab.sessionState === 'running' || tab.sessionState === 'starting');
  const turnKey = messages.at(-1)?.id ?? 'empty';
  const [typedAt, setTypedAt] = useState<string | null>(null);
  const pending = cards.filter(c => (c.state ?? 'pending') === 'pending').map(c => c.kind);
  const { chips, used } = useCareerSuggestions({
    enabled: !!tab,
    streaming,
    turnKey,
    request: () => ({ last_user: visibleText(lastOf(messages, 'user')), last_assistant: visibleText(lastOf(messages, 'assistant')), pending_cards: pending }),
  });
  const visible = typedAt === turnKey ? [] : chips;
  const barRef = useRef<HTMLDivElement>(null);
  useInputKeys(inputRef, barRef, visible, first => {
    suggestToChat(first.text, undefined, 'prefill');
    used(first, 'tab');
  }, typed => setTypedAt(typed ? turnKey : null));
  const send = (chip: SuggestChip, how: 'click' | 'key') => {
    used(chip, how);
    void runSuggestion(chip);
  };
  return <SuggestChips chips={visible} onSend={send} onEscape={() => inputRef.current?.focus()} barRef={barRef} />;
}
