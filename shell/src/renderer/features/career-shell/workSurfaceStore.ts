/**
 * In-chat work surfaces (specs/CAREER_DESIGN.md §5.7): which one is expanded in
 * the chat page's right column, plus the live facts every state shares
 * (browser takeover, assistant progress steps).
 *
 * Kept in a module store so the collapsed card, the expanded panel and the
 * companion panel read one source, and so events that arrive while the chat
 * page is not mounted are not lost.
 */
import { useSyncExternalStore } from 'react';

import type { CareerProgressEvent, CareerTakeoverEvent } from '@/components/career/types';

export type WorkSurface = 'browser' | 'resume' | 'mock-interview' | 'exam';

export interface ProgressStep {
  message: string;
  phase: string;
  at: number;
}

export interface ProgressRun {
  key: string;
  steps: ProgressStep[];
  /** 0–1 when the tool reports it. */
  progress: number | null;
  finished: boolean;
  updatedAt: number;
}

interface WorkSurfaceState {
  expanded: WorkSurface | null;
  /** Object the expanded surface shows (resume / mock interview / exam id). */
  refId: string | null;
  /** Bumped on every expand so a panel can re-select even for the same id. */
  nonce: number;
  /** Short text the card hands to the panel (e.g. the current interview question). */
  context: string | null;
  fullscreen: boolean;
  takeover: CareerTakeoverEvent | null;
  /** Latest run first; only a short history is kept. */
  runs: readonly ProgressRun[];
}

const MAX_RUNS = 5;
const MAX_STEPS = 12;
const FINISHED_PHASES = /(?:^|[_:-])(done|finished|complete|completed|failed|error|cancelled)$/i;

let state: WorkSurfaceState = { expanded: null, refId: null, nonce: 0, context: null, fullscreen: false, takeover: null, runs: [] };
const listeners = new Set<() => void>();

function setState(patch: Partial<WorkSurfaceState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): WorkSurfaceState {
  return state;
}

export function useWorkSurfaces(): WorkSurfaceState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function expandWorkSurface(surface: WorkSurface, options: { fullscreen?: boolean; refId?: string | null; context?: string | null } = {}): void {
  // Only one surface is expanded at a time; opening another replaces it.
  setState({
    expanded: surface,
    refId: options.refId === undefined ? (state.expanded === surface ? state.refId : null) : options.refId,
    context: options.context === undefined ? (state.expanded === surface ? state.context : null) : options.context,
    nonce: state.nonce + 1,
    fullscreen: options.fullscreen ?? (state.expanded === surface ? state.fullscreen : false),
  });
}

export function collapseWorkSurface(surface?: WorkSurface): void {
  if (surface && state.expanded !== surface) return;
  setState({ expanded: null, refId: null, context: null, fullscreen: false });
}

export function setWorkSurfaceFullscreen(fullscreen: boolean): void {
  setState({ fullscreen });
}

export function recordTakeover(takeover: CareerTakeoverEvent | null): void {
  setState({ takeover });
}

/** Folds a career:progress event into the run it belongs to. */
export function recordProgress(event: CareerProgressEvent, now = Date.now()): void {
  if (!event?.message) return;
  const key = event.runId ?? event.taskId ?? event.phase ?? 'progress';
  const existing = state.runs.find(run => run.key === key);
  const step: ProgressStep = { message: event.message, phase: event.phase, at: now };
  const finished = (typeof event.progress === 'number' && event.progress >= 1) || FINISHED_PHASES.test(event.phase ?? '');
  const base: ProgressRun = existing ?? { key, steps: [], progress: null, finished: false, updatedAt: now };
  const lastStep = base.steps[base.steps.length - 1];
  const steps = lastStep?.message === step.message ? base.steps : [...base.steps, step].slice(-MAX_STEPS);
  const run: ProgressRun = {
    ...base,
    steps,
    progress: typeof event.progress === 'number' ? event.progress : base.progress,
    finished,
    updatedAt: now,
  };
  setState({ runs: [run, ...state.runs.filter(other => other.key !== key)].slice(0, MAX_RUNS) });
}

/** Test helper. */
export function resetWorkSurfaces(): void {
  setState({ expanded: null, refId: null, nonce: 0, context: null, fullscreen: false, takeover: null, runs: [] });
}
