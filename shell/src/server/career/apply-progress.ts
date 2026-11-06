/**
 * 每份网申走到哪了，按申请存下来：内存里一份最新的（每个进度事件都更新），kv 里一份落盘的。
 * 界面上每个标签下面的那棵树读的是这里（随 /live/pages 返回），不靠界面自己边收事件边记——
 * 界面重新加载、App 重启、事件发生时界面还没连上，树都还在，而且是这一份自己的
 * （2026-11-06 用户：「树没有跟着标签走…要有对应和持久化」）。
 *
 * 落盘不是每个事件都写：走到新的一环、枝上多了一片新叶子、状态变了才写；填格子的次数这类只在内存里涨，
 * 收尾（settle）时连同核对过的格子数一起写一次。
 */
import type { Repos } from '@career/core';

import { laterStage, nextTrail, parseApplyProgress, type ApplyCells, type ApplyProgress, type ApplyStage } from '../../shared/careerApplyStage';

const KEY = (applicationId: string) => `apply:progress:${applicationId}`;
/** 内存里最多留多少份：一批几百家，再多就把最久没动的丢掉（落盘的那份还在）。 */
const MAX_IN_MEMORY = 500;

const latest = new Map<string, ApplyProgress>();
/** 上次落盘时的样子（哪一环 + 状态 + 枝上有哪些叶子）：一样就不重复写。 */
const persisted = new Map<string, string>();

const shapeOf = (p: ApplyProgress) => `${p.stage ?? ''}|${p.state}|${p.trail.map(t => `${t.stage}:${t.kind}`).join(',')}`;

function remember(applicationId: string, progress: ApplyProgress): void {
  latest.delete(applicationId);
  latest.set(applicationId, progress);
  if (latest.size > MAX_IN_MEMORY) { const oldest = latest.keys().next().value; if (oldest !== undefined) { latest.delete(oldest); persisted.delete(oldest); } }
}

function save(repos: Repos, applicationId: string, progress: ApplyProgress): void {
  try { repos.kvSet(KEY(applicationId), progress); persisted.set(applicationId, shapeOf(progress)); }
  catch (error) { console.warn(`[career] apply-progress save FAILED app=${applicationId}`, error instanceof Error ? error.message : error); }
}

export function applyProgressOf(repos: Repos, applicationId: string): ApplyProgress | undefined {
  const hit = latest.get(applicationId);
  if (hit) return hit;
  let stored: ApplyProgress | undefined;
  try { stored = parseApplyProgress(repos.kvGet(KEY(applicationId))); }
  catch (error) { console.warn(`[career] apply-progress read FAILED app=${applicationId}`, error instanceof Error ? error.message : error); }
  if (stored) { remember(applicationId, stored); persisted.set(applicationId, shapeOf(stored)); }
  return stored;
}

export interface ProgressNote {
  /** 这一条事件报的环；一趟之内只往前走，重头再来的一趟（restart）从头算。 */
  stage?: ApplyStage;
  kind?: string;
  cells?: ApplyCells;
  /** 不给就是 working（小芽在办）。 */
  state?: ApplyProgress['state'];
  /** 这是新的一趟（从选中开始重来）：枝上从头记。 */
  restart?: boolean;
  /** 收尾：不管样子变没变都落盘（次数、格子数是最终的）。 */
  settle?: boolean;
}

/** 记一笔这份网申的进度，返回记完之后的样子。 */
export function noteApplyProgress(repos: Repos, applicationId: string, note: ProgressNote): ApplyProgress {
  const before = note.restart ? undefined : applyProgressOf(repos, applicationId);
  const stage = note.restart ? note.stage : laterStage(before?.stage, note.stage);
  const next: ApplyProgress = {
    state: note.state ?? 'working',
    trail: nextTrail(before?.trail, before?.stage, stage, note.kind) ?? [],
    ...(stage ? { stage } : {}),
    ...(note.kind ?? before?.kind ? { kind: note.kind ?? before?.kind } : {}),
    ...(note.cells ?? before?.cells ? { cells: note.cells ?? before?.cells } : {}),
  };
  remember(applicationId, next);
  if (note.settle || persisted.get(applicationId) !== shapeOf(next)) save(repos, applicationId, next);
  return next;
}

/** 测试用：清掉内存里的。 */
export function resetApplyProgress(): void { latest.clear(); persisted.clear(); }
