/**
 * 选一个对象（岗位 / 公司）的输入框：一点开就列出他自己投过的，打字再去岗位库里找。
 * 目的是不让他打一长串：点一下就选中；列表里没有时，打的字本身也能用（freeText）。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface PickOption {
  /** 库里的对象 id；手打的名字没有 id。 */
  id: string | null;
  label: string;
  hint?: string;
}

/** 打字后隔这么久再去岗位库里找，免得每敲一个字查一次。 */
const SEARCH_DEBOUNCE_MS = 250;
/** 输入框失焦后晚这么久再收起下拉：点选项时输入框会先失焦，要让点击落得下去。 */
const BLUR_CLOSE_DELAY_MS = 120;
/** 下拉里最多列这么多条：再多就该继续打字缩小范围。 */
const MAX_VISIBLE_OPTIONS = 8;

const CONTROL = 'h-9 w-full rounded-md border border-[var(--line-2)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-muted)]';

function useRemoteOptions(query: string, search?: (q: string) => Promise<PickOption[]>): PickOption[] {
  const [found, setFound] = useState<PickOption[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!search || !q) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(q)
        .then(rows => { if (!cancelled) setFound(rows); })
        .catch((error: unknown) => {
          // 岗位库找不了不挡路：他投过的那些还在列表里，手打的名字也能用
          console.warn(`[career-skills] 按「${q}」找岗位失败：`, error instanceof Error ? error.message : error);
          if (!cancelled) setFound([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, search]);
  return query.trim() ? found : [];
}

function mergeOptions(local: PickOption[], remote: PickOption[], query: string): PickOption[] {
  const q = query.trim().toLowerCase();
  const mine = q ? local.filter(option => option.label.toLowerCase().includes(q)) : local;
  const seen = new Set(mine.map(option => option.id ?? option.label));
  const extra = remote.filter(option => !seen.has(option.id ?? option.label));
  return [...mine, ...extra].slice(0, MAX_VISIBLE_OPTIONS);
}

function OptionList({ id, options, active, onActive, onChoose }: {
  id: string; options: PickOption[]; active: number; onActive: (index: number) => void; onChoose: (option: PickOption) => void;
}) {
  return (
    <ul id={id} role="listbox" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] py-1 shadow-md">
      {options.map((option, index) => (
        <li
          key={`${option.id ?? 'text'}:${option.label}`} role="option" aria-selected={index === active}
          onMouseDown={event => { event.preventDefault(); onChoose(option); }}
          onMouseEnter={() => onActive(index)}
          className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm ${index === active ? 'bg-[var(--hover)]' : ''}`}
        >
          <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{option.label}</span>
          {option.hint && <span className="shrink-0 text-xs text-[var(--subtle)]">{option.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

export function PickBox({ ariaLabel, placeholder, value, onChange, options, search, freeText = false, className = '' }: {
  ariaLabel: string; placeholder: string;
  value: PickOption | null; onChange: (next: PickOption | null) => void;
  /** 一点开就列出来的（他自己投过的）。 */
  options: PickOption[];
  /** 打字时再去别处找（岗位库）。 */
  search?: (q: string) => Promise<PickOption[]>;
  /** 列表里没有时，打的字本身也算一个选择。 */
  freeText?: boolean;
  className?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number | null>(null);
  const remote = useRemoteOptions(open ? query : '', search);
  const visible = mergeOptions(options, remote, value && value.label === query ? '' : query);

  useEffect(() => () => { if (blurTimer.current !== null) window.clearTimeout(blurTimer.current); }, []);

  const choose = (option: PickOption) => { onChange(option); setQuery(option.label); setOpen(false); };
  const type = (next: string) => {
    setQuery(next); setOpen(true); setActive(0);
    onChange(freeText && next.trim() ? { id: null, label: next.trim() } : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!open || visible.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => (i + 1) % visible.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => (i - 1 + visible.length) % visible.length); }
    if (event.key === 'Enter') { event.preventDefault(); choose(visible[Math.min(active, visible.length - 1)]); }
  };

  return (
    <div className={`relative ${className}`}>
      <input
        role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        value={query} placeholder={placeholder} className={CONTROL}
        onChange={event => type(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), BLUR_CLOSE_DELAY_MS); }}
        onKeyDown={onKeyDown}
      />
      {open && visible.length > 0 && <OptionList id={listId} options={visible} active={active} onActive={setActive} onChoose={choose} />}
    </div>
  );
}
