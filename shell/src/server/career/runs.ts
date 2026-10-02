/**
 * 投递 run 状态机（内存态）：running → paused(reason) → human_active → resuming → running。
 *
 * 一个 run 对应一次 `apply_run`（托管浏览器上的填表执行）。状态只在本进程内有效，
 * 持久化的接管记录由 Repos.openHandoff / closeHandoff 负责；每次变化都 broadcast
 * `career:takeover`（critical）让前端的接管条同步。
 */
import type { BrowserControlState, HandoffReason } from '@career/core';

export type RunState = Exclude<BrowserControlState, 'idle'>;

/**
 * 与 @career/core 的 BROWSER_CONTROL_TRANSITIONS 保持一致（runs.unit.test.ts 有 parity 断言）。
 * 内联一份是为了让 Session 侧车启动路径不静态依赖 @career/core（见 core-module.ts）。
 */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  running: ['paused'],
  paused: ['human_active', 'resuming'],
  human_active: ['resuming'],
  resuming: ['running'],
};

export interface RunRecord {
  runId: string;
  state: RunState;
  reason?: HandoffReason | string;
  taskId?: string;
  actionId?: string;
  handoffId?: string;
  url?: string;
  message?: string;
  updatedAt: string;
}

export interface TakeoverEvent {
  sessionId: string;
  runId: string;
  state: RunState;
  reason?: string;
  url?: string;
  message?: string;
  taskId?: string;
  handoffId?: string;
}

type Broadcast = (event: string, data: unknown) => void;

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  constructor(private readonly broadcast: Broadcast, private readonly sessionId: () => string) {}

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()];
  }

  start(runId: string, info: Pick<RunRecord, 'taskId' | 'actionId' | 'url'> = {}): RunRecord {
    const rec: RunRecord = { runId, state: 'running', ...info, updatedAt: new Date().toISOString() };
    this.runs.set(runId, rec);
    this.emit(rec);
    return rec;
  }

  /** 按状态机流转；非法流转抛错（中文），调用方决定是否忽略。 */
  transition(runId: string, to: RunState, patch: Partial<Omit<RunRecord, 'runId' | 'state' | 'updatedAt'>> = {}): RunRecord {
    const cur = this.runs.get(runId);
    if (!cur) throw new Error(`run 不存在：${runId}`);
    if (!RUN_TRANSITIONS[cur.state].includes(to)) {
      throw new Error(`不允许的接管流转：${cur.state} → ${to}`);
    }
    const next: RunRecord = { ...cur, ...stripUndefined(patch), state: to, updatedAt: new Date().toISOString() };
    if (to === 'running') {
      delete next.reason;
      delete next.message;
    }
    this.runs.set(runId, next);
    this.emit(next);
    return next;
  }

  pause(runId: string, reason: HandoffReason | string, patch: Partial<Omit<RunRecord, 'runId' | 'state' | 'updatedAt'>> = {}): RunRecord {
    return this.transition(runId, 'paused', { ...patch, reason });
  }

  /** 结束 run：从注册表移除并广播 idle 语义（用 running→idle 的合法流转表达）。 */
  finish(runId: string): void {
    const cur = this.runs.get(runId);
    if (!cur) return;
    this.runs.delete(runId);
  }

  private emit(rec: RunRecord): void {
    const payload: TakeoverEvent = {
      sessionId: this.sessionId(),
      runId: rec.runId,
      state: rec.state,
      ...(rec.reason ? { reason: String(rec.reason) } : {}),
      ...(rec.url ? { url: rec.url } : {}),
      ...(rec.message ? { message: rec.message } : {}),
      ...(rec.taskId ? { taskId: rec.taskId } : {}),
      ...(rec.handoffId ? { handoffId: rec.handoffId } : {}),
    };
    this.broadcast('career:takeover', payload);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

let registry: RunRegistry | null = null;

/** 进程级注册表；首次调用时注入 broadcast 与 sessionId 读取函数。 */
export function getRunRegistry(init?: { broadcast: Broadcast; sessionId: () => string }): RunRegistry {
  if (!registry) {
    if (!init) throw new Error('RunRegistry 尚未初始化');
    registry = new RunRegistry(init.broadcast, init.sessionId);
  }
  return registry;
}

export function resetRunRegistry(): void {
  registry = null;
}
