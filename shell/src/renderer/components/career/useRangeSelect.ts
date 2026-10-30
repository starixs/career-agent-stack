/**
 * 框选（用户 2026-10-30「框选一堆，然后你就直接确认」；不要边滑边逐条点）：
 *  - Shift + 点：从上一次点的那行到这行，整段设成这次点的状态；
 *  - 在勾选列上按住拖：拖过的行都设成按下那一行要变成的状态。
 */
import { useCallback, useEffect, useRef } from 'react';

/** 把 ids 里 from..to（含两端，顺序不限）这一段设成 on。 */
export function setRange(selected: ReadonlySet<string>, ids: readonly string[], from: number, to: number, on: boolean): Set<string> {
  const next = new Set(selected);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (const id of ids.slice(Math.max(0, lo), hi + 1)) { if (on) next.add(id); else next.delete(id); }
  return next;
}

export function useRangeSelect(ids: readonly string[], selected: ReadonlySet<string>, setSelected: (next: Set<string>) => void) {
  const anchor = useRef<number | null>(null);
  /** 按下时的选择和起点：拖回来时能缩回去。moved = 拖到过别的行（松手时的那次点击不再翻转起点行）。 */
  const drag = useRef<{ on: boolean; from: number; base: ReadonlySet<string>; moved: boolean } | null>(null);
  useEffect(() => {
    // 松手后让这一轮的 click 先看到 moved，再清掉
    const end = () => { window.setTimeout(() => { drag.current = null; }, 0); };
    window.addEventListener('mouseup', end);
    return () => window.removeEventListener('mouseup', end);
  }, []);
  /** 点勾选框：带 Shift 时整段，否则单行；刚拖选完松手的那一下不算。 */
  const click = useCallback((id: string, shift: boolean) => {
    const i = ids.indexOf(id);
    if (drag.current?.moved) { anchor.current = i; return; }
    const on = !selected.has(id);
    setSelected(setRange(selected, ids, shift && anchor.current !== null ? anchor.current : i, i, on));
    anchor.current = i;
  }, [ids, selected, setSelected]);
  /** 在勾选列按下：记下起点和要变成的状态。 */
  const pressStart = useCallback((id: string) => {
    drag.current = { on: !selected.has(id), from: ids.indexOf(id), base: selected, moved: false };
  }, [ids, selected]);
  /** 拖进别的行：起点到这行整段设成按下时要变成的状态。 */
  const dragOver = useCallback((id: string) => {
    const d = drag.current;
    if (!d) return;
    const i = ids.indexOf(id);
    if (i !== d.from) d.moved = true;
    if (d.moved) setSelected(setRange(d.base, ids, d.from, i, d.on));
  }, [ids, setSelected]);
  return { click, pressStart, dragOver };
}
