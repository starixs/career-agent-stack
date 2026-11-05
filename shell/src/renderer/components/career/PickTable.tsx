/**
 * 整批勾选表：一张表收完要确认的一批条目，两层操作（2026-10-30 用户定）。
 *  - 第一层：表头一个「全部通过」，一下做完；
 *  - 第二层：逐条勾选后点「确定所选」。勾选不靠一条一条点：
 *    按住拖过几行 = 把这几行设成同一个状态；Shift 点 = 从上次点的那行连到这行；分组勾 = 整组。
 * 几十上百行时（plan-r2 §C「今天这批」）：组可折叠；键盘 ↑↓ 移、空格勾、Shift+↑↓ 连着勾、⌘/Ctrl+A 全选、
 * Enter 交给主按钮；可选的筛选框只筛看得见的行，不改勾选。
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export interface PickRow { id: string; text: string; note?: string | null; chip?: string | null }
export interface PickGroup { id: string; title: string; meta?: string | null; rows: PickRow[]; collapsed?: boolean }
export type Picked = Record<string, boolean>;
type SetMany = (ids: string[], value: boolean) => void;

export const allPicked = (groups: PickGroup[]): Picked => Object.fromEntries(groups.flatMap(g => g.rows.map(r => [r.id, true])));
export const pickedIds = (picked: Picked): string[] => Object.keys(picked).filter(id => picked[id]);

/** 拖选：按下时定好要设成的状态（按下那行取反），拖过的每一行都设成它。 */
function useDragPick(onSet: SetMany) {
  const drag = useRef<{ value: boolean } | null>(null);
  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);
  return {
    set: onSet,
    start: (id: string, current: boolean) => { drag.current = { value: !current }; onSet([id], !current); },
    enter: (id: string) => { if (drag.current) onSet([id], drag.current.value); },
  };
}

const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement && el.type === 'text';

/** 键盘：焦点在某一行上时 ↑↓ 移、Shift+↑↓ 把经过的行设成出发那行的状态、空格勾、Enter 交主按钮；⌘/Ctrl+A 全选看得见的。 */
function useRowKeys(visible: string[], picked: Picked, set: SetMany, onPrimary?: () => void) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const focus = (id: string | undefined) => { if (id) refs.current.get(id)?.focus(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !isTextInput(e.target)) { e.preventDefault(); set(visible, true); return; }
    const id = e.target instanceof HTMLElement ? e.target.dataset.rowId : undefined;
    if (!id) return;
    const i = visible.indexOf(id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (e.shiftKey && next && next !== id) set([next], !!picked[id]);
      focus(next);
    } else if (e.key === ' ' || (e.key === 'Enter' && !onPrimary)) {
      e.preventDefault(); set([id], !picked[id]);
    } else if (e.key === 'Enter' && onPrimary) {
      e.preventDefault(); onPrimary();
    }
  };
  const register = useCallback((id: string, el: HTMLDivElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); }, []);
  return { onKeyDown, register };
}

function GroupBox({ group, rows, picked, onSet, collapsed, onToggle }: {
  group: PickGroup; rows: PickRow[]; picked: Picked; onSet: SetMany; collapsed: boolean; onToggle: () => void;
}) {
  const on = rows.filter(r => picked[r.id]).length;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = on > 0 && on < rows.length; }, [on, rows.length]);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm font-medium text-[var(--ink)]">
      <input ref={ref} type="checkbox" aria-label={`整组：${group.title}`} checked={on === rows.length && on > 0} onChange={e => onSet(rows.map(r => r.id), e.target.checked)} />
      <button type="button" aria-label={`${collapsed ? '展开' : '收起'}：${group.title}`} aria-expanded={!collapsed} onClick={onToggle} className="flex min-w-0 items-center gap-1 text-left">
        <Chevron className="size-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
        <span className="min-w-0 truncate">{group.title}</span>
      </button>
      {group.meta && <span className="shrink-0 text-xs font-normal text-[var(--muted)]">{group.meta}</span>}
      <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-[var(--muted)]">{on}/{rows.length}</span>
    </div>
  );
}

/** 一行。勾选变了只重渲那一行：回调都是稳定的（useRowHandlers），按 id 调。 */
const RowLine = memo(function RowLine({ row, on, unpicked, register, onDown, onEnter }: {
  row: PickRow; on: boolean; unpicked: 'strike' | 'dim'; register: (id: string, el: HTMLDivElement | null) => void;
  onDown: (e: ReactPointerEvent, id: string) => void; onEnter: (id: string) => void;
}) {
  const tone = on ? 'text-[var(--ink)]' : unpicked === 'strike' ? 'text-[var(--subtle)] line-through' : 'text-[var(--subtle)]';
  return (
    <div
      ref={el => register(row.id, el)} role="checkbox" aria-checked={on} aria-label={row.text} tabIndex={0}
      data-testid={`pick-row-${row.id}`} data-row-id={row.id}
      onPointerDown={e => onDown(e, row.id)} onPointerEnter={() => onEnter(row.id)}
      className={`flex cursor-pointer items-start gap-2 border-t border-[var(--line)] px-2 py-1 pl-7 text-sm outline-none focus-visible:bg-[var(--hover)] ${tone}`}
    >
      <input type="checkbox" tabIndex={-1} readOnly checked={on} className="pointer-events-none mt-0.5" aria-hidden />
      <span className="min-w-0 flex-1">{row.text}{row.note && <span className="ml-1 text-xs text-[var(--muted)]">{row.note}</span>}</span>
      {row.chip && <span className="shrink-0 rounded border border-[var(--line)] px-1 text-xs text-[var(--muted)]">{row.chip}</span>}
    </div>
  );
});

const matches = (r: PickRow, q: string) => !q || `${r.text} ${r.note ?? ''}`.toLowerCase().includes(q);

/** 组的折叠状态：初始按组自己的 collapsed，之后由他点开 / 收起。 */
function useCollapsed() {
  const [state, setState] = useState<Record<string, boolean>>({});
  const isCollapsed = (g: PickGroup) => state[g.id] ?? !!g.collapsed;
  const toggle = (g: PickGroup) => setState(s => ({ ...s, [g.id]: !(s[g.id] ?? !!g.collapsed) }));
  return { isCollapsed, toggle };
}

/** 行上的按下 / 拖过：回调稳定不变（读最新的勾选），行组件才能 memo。按下 + Shift = 从上次点的那行连到这行。 */
function useRowHandlers(order: string[], picked: Picked, set: SetMany) {
  const drag = useDragPick(set);
  const latest = useRef({ order, picked, drag });
  useLayoutEffect(() => { latest.current = { order, picked, drag }; });
  const last = useRef<string | null>(null);
  const onDown = useCallback((e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    const { order: o, picked: p, drag: d } = latest.current;
    if (e.shiftKey && last.current) {
      const [a, b] = [o.indexOf(last.current), o.indexOf(id)].sort((x, y) => x - y);
      d.set(o.slice(a, b + 1), !p[id]);
    } else d.start(id, !!p[id]);
    last.current = id;
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
  }, []);
  const onEnter = useCallback((id: string) => latest.current.drag.enter(id), []);
  return { onDown, onEnter };
}

/** 表头：全选 + 已选数、筛选框、操作提示、右侧按钮。 */
function PickHeader({ on, total, onAll, query, onQuery, filterPlaceholder, actions }: {
  on: number; total: number; onAll: (v: boolean) => void; query: string; onQuery: (q: string) => void;
  filterPlaceholder?: string; actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-2 py-1.5">
      <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <input type="checkbox" aria-label="全选" checked={on === total && total > 0} onChange={e => onAll(e.target.checked)} />
        已选 <b className="tabular-nums text-[var(--ink)]">{on}</b> / {total}
      </label>
      {filterPlaceholder && (
        <input type="text" value={query} onChange={e => onQuery(e.target.value)} placeholder={filterPlaceholder} aria-label={filterPlaceholder}
          className="h-6 w-32 rounded border border-[var(--line)] bg-transparent px-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--ink-2)]" />
      )}
      <span className="hidden text-xs text-[var(--subtle)] sm:inline">按住拖过几行可一起勾 / 取消，Shift 点连选</span>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function PickTable({ groups, picked, onChange, actions, unpicked = 'strike', filterPlaceholder, onPrimary }: {
  groups: PickGroup[]; picked: Picked; onChange: (next: Picked) => void;
  /** 表头右侧的两层按钮（全部通过 / 确定所选）。 */
  actions: ReactNode;
  /** 没勾的行怎么显示：strike = 划掉（"这条不要"，如确认说法）；dim = 变淡（"这家先不投"，如批量勾选）。 */
  unpicked?: 'strike' | 'dim';
  /** 给了就出一个筛选框（只筛看得见的行，不改勾选）。 */
  filterPlaceholder?: string;
  /** 行上按 Enter 交给主按钮；不给时 Enter 和空格一样是勾 / 取消。 */
  onPrimary?: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const fold = useCollapsed();
  const order = useMemo(() => groups.flatMap(g => g.rows.map(r => r.id)), [groups]);
  const shown = useMemo(() => groups.map(g => ({ g, rows: g.rows.filter(r => matches(r, q)) })).filter(x => x.rows.length > 0), [groups, q]);
  const visible = shown.flatMap(x => fold.isCollapsed(x.g) ? [] : x.rows.map(r => r.id));
  const set: SetMany = (ids, value) => onChange({ ...picked, ...Object.fromEntries(ids.map(id => [id, value])) });
  const keys = useRowKeys(visible, picked, set, onPrimary);
  const rowsOn = useRowHandlers(order, picked, set);
  return (
    <div data-testid="pick-table" className="overflow-hidden rounded-lg border border-[var(--line)]" onKeyDown={keys.onKeyDown}>
      <PickHeader on={order.filter(id => picked[id]).length} total={order.length} onAll={v => set(order, v)}
        query={query} onQuery={setQuery} filterPlaceholder={filterPlaceholder} actions={actions} />
      <div className="max-h-[min(50vh,560px)] overflow-y-auto select-none">
        {shown.map(({ g, rows }) => (
          <div key={g.id} className="border-b border-[var(--line)] last:border-b-0">
            <GroupBox group={g} rows={rows} picked={picked} onSet={set} collapsed={fold.isCollapsed(g)} onToggle={() => fold.toggle(g)} />
            {!fold.isCollapsed(g) && rows.map(r => (
              <RowLine key={r.id} row={r} on={!!picked[r.id]} unpicked={unpicked} register={keys.register}
                onDown={rowsOn.onDown} onEnter={rowsOn.onEnter} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
