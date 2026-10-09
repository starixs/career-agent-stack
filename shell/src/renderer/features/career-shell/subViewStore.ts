/**
 * Which view a multi-view career page (卷宗 / 素材) shows.
 *
 * The L2 nav writes here before opening the tab, and the page reads it on mount.
 * A module store (not an event) is used because pages mount lazily: an event
 * fired before the page subscribes would be lost on the first open.
 */
import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

let views: Readonly<Record<string, string | undefined>> = {};
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): Readonly<Record<string, string | undefined>> {
  return views;
}

export function setCareerSubView(kind: string, view: string): void {
  if (views[kind] === view) return;
  views = { ...views, [kind]: view };
  for (const listener of listeners) listener();
}

export function useCareerSubViews(): Readonly<Record<string, string | undefined>> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Page-side hook: the current view (falling back to `fallback`) and a setter that keeps the nav in sync. */
export function useCareerSubView<V extends string>(kind: string, fallback: V): [V, (view: V) => void] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const view = (all[kind] as V | undefined) ?? fallback;
  const setView = useCallback((next: V) => setCareerSubView(kind, next), [kind]);
  return [view, setView];
}

/** Test helper: drop all remembered views. */
export function resetCareerSubViews(): void {
  views = {};
  for (const listener of listeners) listener();
}
