/**
 * 批量投递运行器（Global 侧车后台）：把已批准的 fill_form 动作排成队列持续跑，不占对话的工具调用。
 *
 *  - 命令通过 kv `apply:batch:command` 下发（Session 工具 / 渲染层路由都只写 kv），运行器轮询执行：start / pause / stop。
 *  - 状态持久化在 kv `apply:batch:state`，侧车重启后若仍是 running 则自动续跑。
 *  - 每个动作：drive → persistDriveOutcome 落库；遇接管（登录 / 验证码 / 测评）就等用户在浏览器里处理并点"交回"
 *    （handoff.resumed_at 被写上）再从当前页继续，不需要模型再调工具。
 *  - 两个动作之间拟人停顿；平台有风险锁就先跳过该平台；用户正在接管浏览器时等待；每日上限。
 *  - 每次状态变化 broadcast `career:batch`；接管状态同时广播 `career:takeover`，前端接管条 / 现场窗复用。
 */
import type { ActionQueueItem, Repos, Task } from '@career/core';
import { persistDriveOutcome, type DriveEvent, type DriveOutcome } from './drive-outcome';

export type BatchStatus = 'idle' | 'running' | 'paused' | 'stopped';
export interface BatchState {
  status: BatchStatus;
  startedAt?: string;
  updatedAt: string;
  currentActionId?: string;
  currentTitle?: string;
  phase?: 'picking' | 'driving' | 'waiting_user' | 'waiting_control' | 'pacing' | 'rate_locked' | 'daily_cap';
  message?: string;
  done: number;
  failed: number;
  handoffs: number;
  queued: number;
  todayCount: number;
  lastError?: string;
}
export interface BatchCommand { cmd: 'start' | 'pause' | 'stop'; at: string; by?: string }

export const BATCH_STATE_KEY = 'apply:batch:state';
export const BATCH_COMMAND_KEY = 'apply:batch:command';
const DAILY_KEY = (day: string) => `apply:batch:count:${day}`;

export interface DriveRequest { action: ActionQueueItem; payload: Record<string, unknown>; mode: 'start' | 'continue'; resumePath?: string; /** 续跑时上次 needs_user 的标签：用户自己填好的值学进答案库 */ learnFrom?: string[] }
export interface BatchRunnerDeps {
  repos: Repos;
  /** 跑一次 drive（Global 内直接用浏览器宿主），返回 NDJSON 事件数组。 */
  drive: (req: DriveRequest, onEvent: (ev: DriveEvent) => void) => Promise<DriveEvent[]>;
  /** 浏览器当前控制权；human 时等待。 */
  control: () => 'agent' | 'human';
  /**
   * 托管浏览器当前是否开着。等用户处理的接管只有在浏览器还开着时才有意义；
   * 浏览器没了（App 重启 / 被回收）就重新排队、从头打开那一份，不再干等。缺省视为开着。
   */
  hasBrowser?: () => boolean;
  broadcast: (event: string, data: unknown) => void;
  sessionId?: () => string;
  /** 平台是否有风险锁（RiskGuard 的 kv）。 */
  riskLocked?: (platform: string) => boolean;
  resumeFileFor?: (resumeId: unknown) => Promise<string | undefined>;
  pacingMs?: [number, number];
  dailyCap?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => Date;
  log?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class BatchRunner {
  private loop: Promise<void> | null = null;
  private stopRequested = false;
  private pauseRequested = false;
  private wake: (() => void) | null = null;
  constructor(private readonly deps: BatchRunnerDeps) {}

  private get repos() { return this.deps.repos; }
  private now() { return this.deps.now?.() ?? new Date(); }
  private sleep(ms: number) { return (this.deps.sleep ?? realSleep)(ms); }
  private log(msg: string) { this.deps.log?.(`[batch] ${msg}`); }

  state(): BatchState {
    const s = this.repos.kvGet<BatchState>(BATCH_STATE_KEY);
    const base: BatchState = s ?? { status: 'idle', updatedAt: this.now().toISOString(), done: 0, failed: 0, handoffs: 0, queued: 0, todayCount: 0 };
    return { ...base, queued: this.queue().length, todayCount: this.todayCount() };
  }
  private setState(patch: Partial<BatchState>): BatchState {
    const next: BatchState = { ...this.state(), ...patch, updatedAt: this.now().toISOString() };
    this.repos.kvSet(BATCH_STATE_KEY, next);
    this.deps.broadcast('career:batch', { sessionId: this.deps.sessionId?.() ?? 'global', ...next });
    return next;
  }

  /** 队列：已批准的 fill_form，按创建顺序。 */
  queue(): ActionQueueItem[] {
    return this.repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind='fill_form' AND status='approved' ORDER BY created_at`);
  }
  todayCount(): number { return this.repos.kvGet<number>(DAILY_KEY(dayOf(this.now()))) ?? 0; }
  private bumpToday(): void { this.repos.kvSet(DAILY_KEY(dayOf(this.now())), this.todayCount() + 1); }

  /** 写命令（任何进程都可以调）。 */
  static command(repos: Repos, cmd: BatchCommand['cmd'], by?: string): void {
    repos.kvSet(BATCH_COMMAND_KEY, { cmd, at: new Date().toISOString(), by } satisfies BatchCommand);
  }
  /** 轮询命令；由宿主定时调用（或 start() 后内部循环里调用）。 */
  pollCommand(): BatchCommand | undefined {
    const c = this.repos.kvGet<BatchCommand>(BATCH_COMMAND_KEY);
    if (!c) return undefined;
    this.repos.kvSet(BATCH_COMMAND_KEY, null);
    if (c.cmd === 'start') this.start();
    if (c.cmd === 'pause') this.pause();
    if (c.cmd === 'stop') this.stop();
    return c;
  }

  start(): BatchState {
    this.stopRequested = false; this.pauseRequested = false;
    if (this.loop) { this.wake?.(); return this.setState({ status: 'running', message: '继续' }); }
    const s = this.setState({ status: 'running', startedAt: this.now().toISOString(), message: '开始批量投递', lastError: undefined });
    this.loop = this.run().catch(e => { this.setState({ status: 'stopped', lastError: e instanceof Error ? e.message : String(e), message: '运行器异常退出' }); }).finally(() => { this.loop = null; });
    return s;
  }
  pause(): BatchState { this.pauseRequested = true; this.wake?.(); return this.setState({ status: 'paused', message: '暂停：当前这份填完就停' }); }
  stop(): BatchState { this.stopRequested = true; this.wake?.(); return this.setState({ status: 'stopped', message: '已停止' }); }
  /** 侧车启动时调用：上次还在跑就续上。 */
  resumeIfRunning(): void { if (this.state().status === 'running' && !this.loop) this.start(); }
  isRunning(): boolean { return !!this.loop && !this.stopRequested && !this.pauseRequested; }

  private async idle(ms: number): Promise<void> {
    await new Promise<void>(resolve => { this.wake = resolve; void this.sleep(ms).then(resolve); });
    this.wake = null;
    // sleep 被注入成立即返回时也要让出事件循环，避免等待态空转
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  private platformOf(action: ActionQueueItem, payload: Record<string, unknown>): string {
    const url = typeof payload.url === 'string' ? payload.url : '';
    try { return new URL(url).hostname.replace(/^www\./, '') || 'generic'; } catch { return typeof payload.platform === 'string' ? payload.platform : 'generic'; }
  }

  private async run(): Promise<void> {
    const poll = this.deps.pollMs ?? 3000;
    const cap = this.deps.dailyCap ?? 30;
    const [pLo, pHi] = this.deps.pacingMs ?? [20_000, 60_000];
    while (!this.stopRequested) {
      this.pollCommand();
      if (this.pauseRequested) { this.setState({ status: 'paused', phase: undefined, currentActionId: undefined, message: '已暂停' }); return; }
      if (this.deps.control() === 'human') { this.setState({ phase: 'waiting_control', message: '你正在接管浏览器，等待交回' }); await this.idle(poll); continue; }
      if (this.todayCount() >= cap) { this.setState({ phase: 'daily_cap', message: `今日已投 ${this.todayCount()} 份，达到上限 ${cap}，明天继续` }); await this.idle(60_000); continue; }
      // 先处理等用户处理完的接管（handoff 已 resumed 但动作还在 needs_user）
      // Repos.closeHandoff 会把动作置回 executing，所以 needs_user / executing 都算"等续跑"；只看该动作最近一次接管
      const resumable = this.repos.db.get<ActionQueueItem>(`SELECT a.* FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status IN ('needs_user','executing') AND h.resumed_at IS NOT NULL AND h.paused_at=(SELECT MAX(paused_at) FROM handoff WHERE action_id=a.id) ORDER BY h.resumed_at LIMIT 1`);
      const waiting = this.repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status='needs_user' AND h.resumed_at IS NULL`)?.n ?? 0;
      let next: ActionQueueItem | undefined = resumable ?? undefined;
      const mode: 'start' | 'continue' = resumable ? 'continue' : 'start';
      if (!next) {
        const q = this.queue();
        next = q.find(a => !this.deps.riskLocked?.(this.platformOf(a, this.payloadOf(a))));
        if (!next && q.length) { this.setState({ phase: 'rate_locked', message: `队列里 ${q.length} 份所在平台都在风险锁中，稍后再试` }); await this.idle(60_000); continue; }
      }
      if (!next && waiting > 0 && this.deps.hasBrowser && !this.deps.hasBrowser()) {
        const n = this.requeueStaleHandoffs();
        if (n > 0) { this.setState({ message: `浏览器已关闭，重新打开 ${n} 份等你处理的网申` }); continue; }
      }
      if (!next) {
        if (waiting > 0) { this.setState({ phase: 'waiting_user', currentActionId: undefined, message: `有 ${waiting} 份等你在浏览器里处理后交回` }); await this.idle(poll); continue; }
        this.setState({ status: 'idle', phase: undefined, currentActionId: undefined, message: '队列已空，全部处理完' });
        return;
      }
      await this.runOne(next, mode);
      if (this.stopRequested || this.pauseRequested) continue;
      const ms = Math.round(pLo + (this.deps.rng?.() ?? Math.random()) * (pHi - pLo));
      this.setState({ phase: 'pacing', message: `停 ${Math.round(ms / 1000)} 秒再投下一份（像真人）` });
      await this.idle(ms);
    }
    this.setState({ status: 'stopped', phase: undefined, currentActionId: undefined, message: '已停止' });
  }

  /**
   * 浏览器已经不在时，等用户处理的接管页面也没了：关掉这些接管，把动作放回队列（approved），
   * 下一轮按 start 模式从岗位网址重新打开；遇到登录 / 验证码会生成新的、页面还在的接管。
   */
  requeueStaleHandoffs(): number {
    const stale = this.repos.db.all<{ action_id: string; handoff_id: string }>(
      `SELECT a.id AS action_id, h.id AS handoff_id FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status='needs_user' AND h.resumed_at IS NULL`,
    );
    const actions = new Set<string>();
    for (const row of stale) {
      try { this.repos.closeHandoff(row.handoff_id, 'browser_closed'); } catch { /* 已关闭 */ }
      actions.add(row.action_id);
    }
    for (const id of actions) this.repos.setActionStatus(id, 'approved');
    if (actions.size) {
      this.log(`requeued ${actions.size} stale handoff action(s): browser closed`);
      this.deps.broadcast('career:data-changed', { sessionId: this.deps.sessionId?.() ?? 'global', tables: ['handoff', 'action_queue'] });
    }
    return actions.size;
  }

  private payloadOf(a: ActionQueueItem): Record<string, unknown> { try { return JSON.parse(a.payload_json) as Record<string, unknown>; } catch { return {}; } }

  private taskFor(action: ActionQueueItem, payload: Record<string, unknown>, mode: 'start' | 'continue'): Task {
    const existing = mode === 'continue' ? this.repos.db.get<Task>('SELECT * FROM task WHERE kind=? AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1', ['apply', `%"action_id":"${action.id}"%`]) : undefined;
    return existing ?? this.repos.createTask({ title: `网申填表 ${String(payload.job_id ?? '')}`, kind: 'apply', sessionId: this.deps.sessionId?.() ?? null, payload: { ...payload, action_id: action.id, batch: true } });
  }

  async runOne(action: ActionQueueItem, mode: 'start' | 'continue'): Promise<DriveOutcome> {
    const r = this.repos;
    const payload = this.payloadOf(action);
    const job = typeof payload.job_id === 'string' ? r.getJob(payload.job_id) : undefined;
    const title = job ? `${job.company_name ?? ''} ${job.title}`.trim() : String(payload.url ?? action.id);
    const task = this.taskFor(action, payload, mode);
    r.updateTask(task.id, { status: 'running' });
    r.setActionStatus(action.id, 'executing');
    if (action.application_id) { try { r.transition(action.application_id, 'pending', mode === 'start' ? '批量投递开始' : '批量投递续跑'); } catch { /* 已在执行态 */ } }
    const changed = (...tables: string[]) => this.deps.broadcast('career:data-changed', { sessionId: this.deps.sessionId?.() ?? 'global', tables });
    changed('task', 'action_queue', 'application');
    this.setState({ status: 'running', phase: 'driving', currentActionId: action.id, currentTitle: title, message: `${mode === 'start' ? '正在填写' : '继续填写'}：${title}` });
    const runId = `run_${action.id}`;
    const takeover = (state: string, extra: Record<string, unknown> = {}) => this.deps.broadcast('career:takeover', { sessionId: this.deps.sessionId?.() ?? 'global', runId, state, taskId: task.id, ...extra });
    takeover('running', { url: payload.url });
    const events: DriveEvent[] = [];
    try {
      const resumePath = await this.deps.resumeFileFor?.(payload.resume_id);
      let learnFrom: string[] | undefined;
      if (mode === 'continue') {
        try { const prev = JSON.parse(action.result_json ?? 'null') as { needsUser?: Array<{ label?: string }> } | null; learnFrom = (prev?.needsUser ?? []).map(p => p.label).filter((l): l is string => typeof l === 'string' && !!l); } catch { /* ignore */ }
      }
      await this.deps.drive({ action, payload, mode, resumePath, ...(learnFrom?.length ? { learnFrom } : {}) }, ev => {
        events.push(ev);
        if (ev.type === 'progress') this.deps.broadcast('career:progress', { sessionId: this.deps.sessionId?.() ?? 'global', runId, taskId: task.id, phase: 'apply_batch', message: String(ev.message ?? '') });
      });
    } catch (e) {
      events.push({ type: 'error', status: 500, error: e instanceof Error ? e.message : String(e) });
    }
    const outcome = persistDriveOutcome({
      repos: r, action, taskId: task.id, events, changed,
      review: (ids, kind, summary) => this.deps.broadcast('career:review', { sessionId: this.deps.sessionId?.() ?? 'global', actionIds: ids, kind, summary }),
    });
    if (mode === 'start') this.bumpToday();
    const s = this.state();
    if (outcome.kind === 'handoff') {
      takeover('paused', { reason: outcome.reason, handoffId: outcome.handoffId, url: outcome.finalUrl, message: outcome.userAction ?? outcome.message });
      this.setState({ handoffs: s.handoffs + 1, phase: 'waiting_user', message: `「${title}」需要你处理：${outcome.userAction ?? outcome.message}` });
      this.log(`handoff ${action.id}: ${outcome.reason}`);
    } else if (outcome.kind === 'done') {
      takeover('idle');
      this.setState({ done: s.done + 1, message: `「${title}」已填好，等你审核提交${outcome.pending ? `（${outcome.pending} 项待补）` : ''}` });
    } else {
      takeover('idle');
      this.setState({ failed: s.failed + 1, lastError: outcome.message, message: `「${title}」${outcome.blocked ? '被阻塞' : '失败'}：${outcome.message}` });
    }
    return outcome;
  }
}
