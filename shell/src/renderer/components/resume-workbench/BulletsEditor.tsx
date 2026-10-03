/**
 * 简历描述的结构化编辑：一段可选的说明文字 + 一条条要点。
 * 存成模板认的富文本（`<p>…</p><ul><li><p>…</p></li></ul>`），与内容侧的要点列表一一对应。
 *  - 回车：在下面新起一条；空行按退格：删掉这条回到上一条；Alt+↑/↓：移动这条。
 */
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 不 trim：编辑中行尾的空格要保留，否则英文单词之间打不出空格
const text = (html: string) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));

export interface RichParts { paragraphs: string[]; bullets: string[] }

/** 富文本 → 说明段落 + 要点（只认段落与列表；其它标签去掉保留文字）。 */
export function parseRich(html: string): RichParts {
  if (!html) return { paragraphs: [], bullets: [] };
  const bullets: string[] = [];
  const withoutLists = html.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => {
    // 空要点也保留：刚按回车新起的一条要能显示出来（内容侧回写时会忽略空行）
    for (const m of inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) bullets.push(text(m[1]));
    return '';
  });
  const paragraphs = [...withoutLists.matchAll(/<(p|h[1-6]|div)[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => text(m[2])).filter(t => t.trim());
  if (!paragraphs.length) { const t = text(withoutLists); if (t.trim()) paragraphs.push(t); }
  return { paragraphs, bullets };
}

export function buildRich({ paragraphs, bullets }: RichParts): string {
  const p = paragraphs.filter(x => x.trim()).map(x => `<p>${esc(x)}</p>`).join('');
  const list = bullets.map(b => `<li><p>${esc(b)}</p></li>`).join('');
  return p + (list ? `<ul>${list}</ul>` : '');
}

function AutoTextarea({ value, onChange, onKeyDown, placeholder, ariaLabel, inputRef }: {
  value: string; onChange: (v: string) => void; onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string; ariaLabel: string; inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [value]);
  return (
    <textarea
      ref={el => { ref.current = el; inputRef?.(el); }}
      rows={1}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className="block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-subtle)] hover:border-[var(--line-subtle)] focus:border-[var(--focus-border)] focus:bg-[var(--paper)] focus:outline-none"
    />
  );
}

export function BulletsEditor({ value, onChange, label = '描述', allowParagraph = true }: {
  value: string;
  onChange: (html: string) => void;
  label?: string;
  allowParagraph?: boolean;
}) {
  const parts = parseRich(value);
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusAt.current === null) return;
    const el = refs.current[focusAt.current];
    focusAt.current = null;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });

  const set = (next: RichParts) => onChange(buildRich(next));
  const setBullet = (i: number, v: string) => { const b = [...parts.bullets]; b[i] = v; set({ ...parts, bullets: b }); };
  const insertAfter = (i: number) => { const b = [...parts.bullets]; b.splice(i + 1, 0, ''); focusAt.current = i + 1; set({ ...parts, bullets: b }); };
  const remove = (i: number) => { const b = parts.bullets.filter((_, j) => j !== i); focusAt.current = Math.max(0, i - 1); set({ ...parts, bullets: b }); };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= parts.bullets.length) return;
    const b = [...parts.bullets]; [b[i], b[j]] = [b[j], b[i]]; focusAt.current = j; set({ ...parts, bullets: b });
  };
  const bullets = parts.bullets;

  return (
    <div className="space-y-1">
      <div className="text-xs text-[var(--ink-muted)]">{label}</div>
      {allowParagraph && (
        <AutoTextarea
          ariaLabel={`${label}：说明`}
          placeholder="一句话说明（可选）"
          value={parts.paragraphs.join(' ')}
          onChange={v => set({ ...parts, paragraphs: [v.replace(/\n/g, ' ')] })}
          onKeyDown={e => {
            // 说明只有一段：回车跳到第一条要点（没有就新起一条）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (bullets.length) { refs.current[0]?.focus(); } else { insertAfter(-1); } }
          }}
        />
      )}
      <ul className="space-y-0.5">
        {bullets.map((b, i) => (
          <li key={i} className="group flex items-start gap-1">
            <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-[var(--ink-muted)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <AutoTextarea
                ariaLabel={`${label}：第 ${i + 1} 条`}
                value={b}
                inputRef={el => { refs.current[i] = el; }}
                onChange={v => setBullet(i, v)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); insertAfter(i); }
                  else if (e.key === 'Backspace' && !b) { e.preventDefault(); remove(i); }
                  else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
                  else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
                }}
              />
            </div>
            <div className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" aria-label="上移" className="rounded p-1 text-[var(--ink-subtle)] hover:text-[var(--ink)]" onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></button>
              <button type="button" aria-label="下移" className="rounded p-1 text-[var(--ink-subtle)] hover:text-[var(--ink)]" onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></button>
              <button type="button" aria-label="删除这条" className="rounded p-1 text-[var(--ink-subtle)] hover:text-[var(--error)]" onClick={() => remove(i)}><X className="size-3.5" /></button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => insertAfter(bullets.length - 1)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        <Plus className="size-3.5" />添加要点
      </button>
    </div>
  );
}
