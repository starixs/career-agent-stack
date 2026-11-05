/**
 * 技能成果页共用的几块小积木：带小标题的一段、一组要点、可展开的一行。
 * 都直接放在纸面上，不画框（CAREER_DESIGN 2.3）。
 */
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--muted)]">{label}</div>
      {children}
    </div>
  );
}

/** 一组要点；空的不渲染，调用方不用先判断。 */
export function Bullets({ label, items, ordered = false }: { label: string; items: string[]; ordered?: boolean }) {
  if (items.length === 0) return null;
  const List = ordered ? 'ol' : 'ul';
  return (
    <Block label={label}>
      <List className={`space-y-1 pl-5 text-sm leading-relaxed text-[var(--ink-2)] ${ordered ? 'list-decimal' : 'list-disc'}`}>
        {items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
      </List>
    </Block>
  );
}

/**
 * 可展开的一行：整行可点，标题区常显，详情点开才出现。
 * 一屏只想看到每条是什么，细节要看哪条点哪条。
 */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--subtle)] transition-transform ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open && <div className="space-y-4 pb-4 pl-6 pt-1">{children}</div>}
    </div>
  );
}

/** 一组成果的外壳：行与行之间一条细线。名字只给读屏用，页面上不再重复一遍标题。 */
export function ResultList({ label, children }: { label: string; children: ReactNode }) {
  return <section aria-label={label} className="divide-y divide-[var(--line)] border-t border-[var(--line)]">{children}</section>;
}
