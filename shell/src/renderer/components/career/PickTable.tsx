/**
 * 整批勾选表：一张表收完要确认的一批条目，两层操作（2026-10-30 用户定）。
 *  - 第一层：表头一个「全部通过」，一下做完；
 *  - 第二层：逐条勾选后点「确定所选」。勾选不靠一条一条点：
 *    按住拖过几行 = 把这几行设成同一个状态；Shift 点 = 从上次点的那行连到这行；分组勾 = 整组。
 * 行很矮、操作在表头，不用边滚边点。
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export interface PickRow { id: string; text: string; note?: string | null }
export interface PickGroup { id: string; title: string; meta?: string | null; rows: PickRow[] }
export type Picked = Record<string, boolean>;

export const allPicked = (groups: PickGroup[]): Picked => Object.fromEntries(groups.flatMap(g => g.rows.map(r => [r.id, true])));
export const pickedIds = (picked: Picked): string[] => Object.keys(picked).filter(id => picked[id]);

/** 拖选：按下时定好要设成的状态（按下那行取反），拖过的每一行都设成它。 */
function useDragPick(onSet: (ids: string[], value: boolean) => void) {
  const drag = useRef<{ value: boolean } | null>(null);
  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);
  return {
    start: (id: string, current: boolean) => { drag.current = { value: !current }; onSet([id], !current); },
    enter: (id: string) => { if (drag.current) onSet([id], drag.current.value); },
  };
}

function GroupBox({ group, picked, onSet }: { group: PickGroup; picked: Picked; onSet: (ids: string[], v: boolean) => void }) {
  const on = group.rows.filter(r => picked[r.id]).length;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = on > 0 && on < group.rows.length; }, [on, group.rows.length]);
  return (
    <label className="flex items-center gap-2 px-2 py-1.5 text-sm font-medium text-[var(--ink)]">
      <input ref={ref} type="checkbox" aria-label={`整组：${group.title}`} checked={on === group.rows.length && on > 0} onChange={e => onSet(group.rows.map(r => r.id), e.target.checked)} />
      <span className="min-w-0 truncate">{group.title}</span>
      {group.meta && <span className="shrink-0 text-xs font-normal text-[var(--muted)]">{group.meta}</span>}
      <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-[var(--muted)]">{on}/{group.rows.length}</span>
    </label>
  );
}

export function PickTable({ groups, picked, onChange, actions, unpicked = 'strike' }: {
  groups: PickGroup[]; picked: Picked; onChange: (next: Picked) => void;
  /** 表头右侧的两层按钮（全部通过 / 确定所选）。 */
  actions: ReactNode;
  /** 没勾的行怎么显示：strike = 划掉（"这条不要"，如确认说法）；dim = 变淡（"这家先不投"，如批量勾选）。 */
  unpicked?: 'strike' | 'dim';
}) {
  const order = groups.flatMap(g => g.rows.map(r => r.id));
  const last = useRef<string | null>(null);
  const set = (ids: string[], value: boolean) => onChange({ ...picked, ...Object.fromEntries(ids.map(id => [id, value])) });
  const drag = useDragPick(set);
  const total = order.length;
  const on = order.filter(id => picked[id]).length;
  const onRowDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    if (e.shiftKey && last.current) {
      const [a, b] = [order.indexOf(last.current), order.indexOf(id)].sort((x, y) => x - y);
      set(order.slice(a, b + 1), !picked[id]);
    } else drag.start(id, !!picked[id]);
    last.current = id;
  };
  return (
    <div data-testid="pick-table" className="overflow-hidden rounded-lg border border-[var(--line)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-2 py-1.5">
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <input type="checkbox" aria-label="全选" checked={on === total && total > 0} onChange={e => set(order, e.target.checked)} />
          已选 <b className="tabular-nums text-[var(--ink)]">{on}</b> / {total}
        </label>
        <span className="hidden text-xs text-[var(--subtle)] sm:inline">按住拖过几行可一起勾 / 取消，Shift 点连选</span>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      <div className="max-h-[360px] overflow-y-auto select-none">
        {groups.map(g => (
          <div key={g.id} className="border-b border-[var(--line)] last:border-b-0">
            <GroupBox group={g} picked={picked} onSet={set} />
            {g.rows.map(r => (
              <div
                key={r.id} role="checkbox" aria-checked={!!picked[r.id]} aria-label={r.text} tabIndex={0}
                data-testid={`pick-row-${r.id}`}
                onPointerDown={e => onRowDown(e, r.id)} onPointerEnter={() => drag.enter(r.id)}
                onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); set([r.id], !picked[r.id]); } }}
                className={`flex cursor-pointer items-start gap-2 border-t border-[var(--line)] px-2 py-1 pl-7 text-sm ${picked[r.id] ? 'text-[var(--ink)]' : unpicked === 'strike' ? 'text-[var(--subtle)] line-through' : 'text-[var(--subtle)]'}`}
              >
                <input type="checkbox" tabIndex={-1} readOnly checked={!!picked[r.id]} className="pointer-events-none mt-0.5" aria-hidden />
                <span className="min-w-0 flex-1">{r.text}{r.note && <span className="ml-1 text-xs text-[var(--muted)]">{r.note}</span>}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
