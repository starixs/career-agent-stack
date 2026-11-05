/**
 * 建议条（2026-11-05 你定）：一行三条——配合 / 犹豫 / 纠正，浮在输入框上沿，和输入框同宽对齐。
 *
 * 每条一个胶囊，单行，放不下截断（悬停看全文）；直接办事的带小图标。
 * 点一下或 Enter = 执行（say 发出、fill 填入、do 直接办，见 suggestActions.ts）；
 * 输入框空着：Tab 把第一条填进输入框，↑ 进条，← → 在三条间走，Esc 回输入框。
 * 他一打字、小芽在说话时都不出现。
 */
import { ArrowUpRight, Eye, LogIn, Send, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { useCareerCards } from '@/context/CareerCardsContext';
import { useTabStateOptional } from '@/context/TabContext';

import { BLANK, FILL_BLANK, fillText, prefillChip, runSuggestion } from './suggestActions';
import { buildSuggestRequest, lastOf, useCareerSuggestions } from './useCareerSuggestions';
import type { SuggestAction, SuggestChip } from '../../../shared/careerSuggest';

export { visibleText } from './useCareerSuggestions';

const ICONS: Partial<Record<SuggestAction['type'], LucideIcon>> = {
  propose_batch: Send, start_card: Send, ask_primary: Send, open_deck: LogIn, open: Eye, start_feature: ArrowUpRight,
};

/** 一格的小图标：点了直接办的按动作标（起头用斜箭头）；替他说的话（answer / option / 发话）不加。 */
function iconOf(chip: SuggestChip): LucideIcon | undefined {
  if (chip.kind === 'do' && chip.action) return ICONS[chip.action.type];
  return chip.mode === 'start' ? ArrowUpRight : undefined;
}

/** 一条最多占一行的三分之一（减去两道间距），三条总放得下。 */
const PILL = 'pointer-events-auto flex h-8 min-w-0 max-w-[calc((100%-1rem)/3)] items-center gap-1.5 rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink-2)] shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]';

/** ← → 在一行里走；↓ 回输入框由调用方处理。 */
function nextIndex(key: string, i: number, n: number): number | null {
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  if (!step) return null;
  const to = i + step;
  return to >= 0 && to < n ? to : i;
}

/** 格里的字；填空格的空画成一段看得见的空（"大概 ＿＿ 人参加："）。 */
function ChipText({ chip }: { chip: SuggestChip }) {
  const m = chip.kind === 'fill' ? FILL_BLANK.exec(chip.text) : null;
  if (!m) return <span className="min-w-0 truncate">{chip.text}</span>;
  return (
    <span className="min-w-0 truncate">
      {chip.text.slice(0, m.index)}
      <span data-blank className="text-[var(--subtle)]">{BLANK}</span>
      {chip.text.slice(m.index + m[0].length)}
    </span>
  );
}

export function SuggestChips({ chips, onSend, onEscape, barRef }: {
  chips: SuggestChip[];
  onSend: (chip: SuggestChip, how: 'click' | 'key') => void;
  onEscape?: () => void;
  barRef?: RefObject<HTMLDivElement | null>;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!chips.length) return null;
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'Escape' || e.key === 'ArrowDown') { e.preventDefault(); onEscape?.(); return; }
    if (e.key === 'Enter') { e.preventDefault(); onSend(chips[i], 'key'); return; }
    const to = nextIndex(e.key, i, chips.length);
    if (to === null) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  return (
    <div
      ref={barRef} data-testid="career-suggest-chips" role="group" aria-label="可以这样回"
      className="pointer-events-none mb-2 flex w-full max-w-[820px] flex-nowrap items-center gap-2"
    >
      {chips.map((c, i) => {
        const Icon = iconOf(c);
        const full = c.kind === 'fill' ? fillText(c.text) : c.text;
        return (
          <button
            key={`${c.slot}:${c.text}`} ref={el => { refs.current[i] = el; }} type="button"
            title={i === 0 ? `${full}（Tab 填入）` : full}
            data-slot={c.slot} data-kind={c.kind} data-mode={c.mode} data-stance={c.stance ?? ''}
            onClick={() => onSend(c, 'click')} onKeyDown={e => onKey(e, i)}
            className={PILL}
          >
            {Icon && <Icon size={12} aria-hidden className="shrink-0" />}
            <ChipText chip={c} />
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
  const last = messages.at(-1);
  const lastAt = last ? new Date(last.timestamp).getTime() : null;
  const turnStart = lastOf(messages, 'user');
  const turnFrom = turnStart ? new Date(turnStart.timestamp).getTime() : 0;
  const { chips, used } = useCareerSuggestions({
    enabled: !!tab,
    streaming,
    turnKey,
    sessionId: tab?.sessionId ?? null,
    lastAt: Number.isFinite(lastAt) ? lastAt : null,
    request: () => buildSuggestRequest(messages, pending, cards.filter(c => Date.parse(c.createdAt) >= turnFrom).map(c => c.kind)),
  });
  const visible = typedAt === turnKey ? [] : chips;
  const barRef = useRef<HTMLDivElement>(null);
  const getInput = () => inputRef.current;
  useInputKeys(inputRef, barRef, visible, first => {
    prefillChip(first, getInput);
    used(first, 'tab');
  }, typed => setTypedAt(typed ? turnKey : null));
  const send = (chip: SuggestChip, how: 'click' | 'key') => {
    used(chip, how);
    void runSuggestion(chip, getInput);
  };
  return <SuggestChips chips={visible} onSend={send} onEscape={() => inputRef.current?.focus()} barRef={barRef} />;
}
