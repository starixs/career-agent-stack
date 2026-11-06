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

import { APPLY_STAGES, isApplyStage, parseApplyCells, type ApplyCells, type ApplyStage } from '../../../shared/careerApplyStage';

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
  /** 结束在失败上（phase 以 failed / error / cancelled 结尾）。 */
  failed?: boolean;
  /** 填好了、停在提交前等他投出（phase 以 _ready 结尾）。 */
  ready?: boolean;
  updatedAt: number;
  /** 批量网申的岗位身份；同一事件流里按 run 分开，不能把不同岗位合成一条。 */
  company?: string;
  jobTitle?: string;
  applicationId?: string;
  /** 走到整条链路的哪一环（只往前走）。 */
  stage?: ApplyStage;
  /** 最近一步是哪类动作（填格子 / 传简历…）。 */
  kind?: string;
  /** 这张表的格子：一共几格、填好几格、几格等他。 */
  cells?: ApplyCells;
  /** 每一环里做过哪几类事、各做了几次（按第一次出现的先后）：链路上每一环往下分的那一小枝。 */
  trail?: readonly TrailStep[];
}

export interface TrailStep { stage: ApplyStage; kind: string; count: number }

/** 记一笔这一环做的这类事；链路往回走了（同一份重头再来）就从头记。 */
function nextTrail(trail: readonly TrailStep[] | undefined, before: ApplyStage | undefined, stage: ApplyStage | undefined, kind: string | undefined): readonly TrailStep[] | undefined {
  const restarted = !!before && !!stage && APPLY_STAGES.indexOf(stage) < APPLY_STAGES.indexOf(before);
  const kept = restarted ? [] : trail ?? [];
  if (!stage || !kind) return restarted ? kept : trail;
  const hit = kept.find(t => t.stage === stage && t.kind === kind);
  return hit ? kept.map(t => (t === hit ? { ...t, count: t.count + 1 } : t)) : [...kept, { stage, kind, count: 1 }];
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

const MAX_RUNS = 50;
const MAX_STEPS = 12;
const FINISHED_PHASES = /(?:^|[_:-])(done|ready|finished|complete|completed|failed|error|cancelled)$/i;
const FAILED_PHASES = /(?:^|[_:-])(failed|error|cancelled)$/i;
const READY_PHASE = /_ready$/i;

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
  // 同一份网申（填表、续填、提交）是一条：按 application_id 认回原来那条，不按事件来源拆成几条（2026-11-05 滴滴提交后多出一条「网申任务」）
  const sameApp = event.application_id ? state.runs.find(run => run.applicationId === event.application_id) : undefined;
  const key = sameApp?.key ?? event.runId ?? event.taskId ?? event.phase ?? 'progress';
  const existing = state.runs.find(run => run.key === key);
  const step: ProgressStep = { message: event.message, phase: event.phase, at: now };
  const finished = (typeof event.progress === 'number' && event.progress >= 1) || FINISHED_PHASES.test(event.phase ?? '');
  const base: ProgressRun = existing ?? { key, steps: [], progress: null, finished: false, updatedAt: now };
  const identity = { company: event.company ?? base.company, jobTitle: event.job_title ?? base.jobTitle, applicationId: event.application_id ?? base.applicationId };
  const lastStep = base.steps[base.steps.length - 1];
  const steps = lastStep?.message === step.message ? base.steps : [...base.steps, step].slice(-MAX_STEPS);
  const run: ProgressRun = {
    ...base,
    steps,
    progress: typeof event.progress === 'number' ? event.progress : base.progress,
    finished,
    failed: FAILED_PHASES.test(event.phase ?? ''),
    ready: READY_PHASE.test(event.phase ?? ''),
    // 服务端一趟之内只往前报；重头再来的一趟会从头报起，这里照收
    stage: isApplyStage(event.stage) ? event.stage : base.stage,
    kind: event.kind ?? base.kind,
    cells: parseApplyCells(event.cells) ?? base.cells,
    trail: nextTrail(base.trail, base.stage, isApplyStage(event.stage) ? event.stage : base.stage, event.kind ?? ((event.phase ?? '').startsWith('submit') ? 'submit' : undefined)),
    updatedAt: now,
    ...identity,
  };
  setState({ runs: [run, ...state.runs.filter(other => other.key !== key)].slice(0, MAX_RUNS) });
}

/**
 * Tools only report that a step started; when a tool returns or the turn ends nothing says it finished.
 * Called at those moments so the companion stops showing a step that is already over.
 */
export function settleProgressRuns(): void {
  if (!state.runs.some(run => !run.finished)) return;
  setState({ runs: state.runs.map(run => (run.finished ? run : { ...run, finished: true })) });
}

/** Test helper. */
export function resetWorkSurfaces(): void {
  setState({ expanded: null, refId: null, nonce: 0, context: null, fullscreen: false, takeover: null, runs: [] });
}
