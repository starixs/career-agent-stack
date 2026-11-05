/**
 * 批量投递运行器（Global 侧车后台）：把已批准的 fill_form 动作排成队列持续跑，不占对话的工具调用。
 *
 *  - 命令通过 kv `apply:batch:command` 下发（Session 工具 / 渲染层路由都只写 kv），运行器轮询执行：start / pause / stop。
 *  - 状态持久化在 kv `apply:batch:state`，侧车重启后若仍是 running 则自动续跑。
 *  - 每个动作：drive → persistDriveOutcome 落库；遇接管（登录 / 验证码 / 测评）就等用户在浏览器里处理并点"交回"
 *    （handoff.resumed_at 被写上）再从当前页继续，不需要模型再调工具。
 *  - 并行（p-queue）：不同网站同时填（默认 2 份，每份网申在自己的页面上），同一网站严格串行；
 *    同一网站两份之间拟人停顿；平台有风险锁就先跳过该平台；用户正在接管浏览器时不再开新的。没有每日上限（用户 2026-10-30「不要做上限」）。
 *  - 每次状态变化 broadcast `career:batch`；接管状态同时广播 `career:takeover`，前端接管条 / 现场窗复用。
 */
import PQueue from 'p-queue';
import { aggregatorHostOf, autoRetryFailedFill, type ActionQueueItem, type Repos, type Task } from '@career/core';
import { applyTaskTitle, isBrowserDown, isTransientDriveError, persistDriveOutcome, type DriveEvent, type DriveOutcome } from './drive-outcome';

export type BatchStatus = 'idle' | 'running' | 'paused' | 'stopped';
export interface BatchState {
  status: BatchStatus;
  startedAt?: string;
  updatedAt: string;
  currentActionId?: string;
  currentTitle?: string;
  /** 正在并行填写的网申（每个网站至多一份）。 */
  running?: Array<{ actionId: string; title: string; host: string }>;
  concurrency?: number;
  phase?: 'picking' | 'driving' | 'waiting_user' | 'waiting_control' | 'pacing' | 'rate_locked';
  message?: string;
  done: number;
  failed: number;
  handoffs: number;
  queued: number;
  todayCount: number;
  lastError?: string;
  /** 只填这几份（批准即填）：不碰队列里其他已批准的；空 = 全量批量。重启后按它续，不会变成全量。 */
  only?: string[];
  /** 只填模式结束后回到的状态：用户之前暂停 / 停止的批量不会因为批准一份就被放开。 */
  resumeTo?: BatchStatus;
}
/** run = 只填 ids 这几份（审批卡片批准即填）；start = 全量批量。 */
export interface BatchCommand { cmd: 'start' | 'pause' | 'stop' | 'run'; at: string; by?: string; ids?: string[] }

export const BATCH_STATE_KEY = 'apply:batch:state';
export const BATCH_COMMAND_KEY = 'apply:batch:command';
const DAILY_KEY = (day: string) => `apply:batch:count:${day}`;
/** 同一份网申页面连着打不开几次就判失败：站点慢偶尔一两次常见，三次多半是链接失效或站点挂了。 */
const MAX_SITE_RETRIES = 3;
/** 托管浏览器起不来：整批歇这么久再试（扩展连接本身要等 45 秒，太密只会一直撞）。 */
const BROWSER_DOWN_BACKOFF_MS = 60_000;

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
  /**
   * 这份网申的页面还在不在（浏览器开着、但学生把那个窗口 / 标签关了）。缺省视为在。
   * 2026-10-31 实例测试：学生下意识关掉外面那个「一模一样的浏览器」，产品里没画面、也一直干等。
   */
  pageGone?: (action: Pick<ActionQueueItem, 'id' | 'application_id'>) => boolean;
  broadcast: (event: string, data: unknown) => void;
  sessionId?: () => string;
  /** 平台是否有风险锁（RiskGuard 的 kv）。 */
  riskLocked?: (platform: string) => boolean;
  /** 这份投递要上传的简历文件：优先材料包（核对哈希），旧动作按 resume_id 现导。 */
  resumeFileFor?: (payload: Record<string, unknown>) => Promise<{ path?: string; error?: string }>;
  pacingMs?: [number, number];
  /** 同时填几份（不同网站）；同一网站永远串行。缺省 2。 */
  concurrency?: number;
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
  /** 每个网站因"暂时不可用 / 被占用"退避到的最早重试时间（毫秒时间戳）。 */
  private transientCooldown = new Map<string, number>();
  /** 托管浏览器起不来时，到这个时间点之前整批不开新的。 */
  private browserDownUntil = 0;
  private siteFailures = new Map<string, number>();
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

  /** 队列：已批准的 fill_form，按创建顺序；只填模式下只含指定的那几份。 */
  queue(): ActionQueueItem[] {
    const all = this.repos.db.all<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind='fill_form' AND status='approved' ORDER BY created_at`);
    const only = this.only();
    return only ? all.filter(a => only.has(a.id)) : all;
  }
  private only(): Set<string> | null {
    const ids = this.repos.kvGet<BatchState>(BATCH_STATE_KEY)?.only;
    return ids?.length ? new Set(ids) : null;
  }
  todayCount(): number { return this.repos.kvGet<number>(DAILY_KEY(dayOf(this.now()))) ?? 0; }
  private bumpToday(): void { this.repos.kvSet(DAILY_KEY(dayOf(this.now())), this.todayCount() + 1); }

  /** 写命令（任何进程都可以调）。 */
  static command(repos: Repos, cmd: BatchCommand['cmd'], by?: string, ids?: string[]): void {
    // 命令只有一个槽位：连续批准几份（轮询还没取走）要合并，不能后一份盖掉前一份；已有全量 start 就不用再加
    const pending = repos.kvGet<BatchCommand>(BATCH_COMMAND_KEY);
    if (cmd === 'run' && pending?.cmd === 'start') return;
    const merged = cmd === 'run' ? [...new Set([...(pending?.cmd === 'run' ? pending.ids ?? [] : []), ...(ids ?? [])])] : undefined;
    repos.kvSet(BATCH_COMMAND_KEY, { cmd, at: new Date().toISOString(), by, ...(merged ? { ids: merged } : {}) } satisfies BatchCommand);
  }
  /** 轮询命令；由宿主定时调用（或 start() 后内部循环里调用）。 */
  pollCommand(): BatchCommand | undefined {
    const c = this.repos.kvGet<BatchCommand>(BATCH_COMMAND_KEY);
    if (!c) return undefined;
    this.repos.kvSet(BATCH_COMMAND_KEY, null);
    if (c.cmd === 'start') this.start();
    if (c.cmd === 'run') this.run(c.ids ?? []);
    if (c.cmd === 'pause') this.pause();
    if (c.cmd === 'stop') this.stop();
    return c;
  }

  start(): BatchState {
    this.stopRequested = false; this.pauseRequested = false;
    if (this.loop) { this.wake?.(); return this.setState({ status: 'running', message: '继续', only: undefined, resumeTo: undefined }); }
    const s = this.setState({ status: 'running', startedAt: this.now().toISOString(), message: '开始批量投递', lastError: undefined, only: undefined, resumeTo: undefined });
    this.spawn();
    return s;
  }
  /**
   * 只填这几份（审批卡片批准即填）。全量批量正在跑：它们本来就在队列里，什么都不改；
   * 否则只填它们，队列里其他已批准的不动，填完回到之前的状态（暂停的批量仍是暂停）。
   */
  run(ids: string[]): BatchState {
    const cur = this.state();
    if (!ids.length) return cur;
    if (this.loop && !cur.only?.length && !this.pauseRequested && !this.stopRequested) { this.wake?.(); return cur; }
    const resumeTo = cur.only?.length ? cur.resumeTo : (cur.status === 'paused' || cur.status === 'stopped' ? cur.status : 'idle');
    const only = [...new Set([...(cur.only ?? []), ...ids])];
    this.pauseRequested = false;
    // 正在停止中的循环会退出：等它退出后再开
    if (this.loop && this.stopRequested) this.restartAfterStop = true;
    this.stopRequested = false;
    const s = this.setState({ status: 'running', only, resumeTo, message: `填写你刚批准的 ${only.length} 份网申`, lastError: undefined, ...(this.loop ? {} : { startedAt: this.now().toISOString() }) });
    if (this.loop) this.wake?.(); else this.spawn();
    return s;
  }
  private restartAfterStop = false;
  private spawn(): void {
    this.loop = this.loopBody().catch(e => { this.setState({ status: 'stopped', lastError: e instanceof Error ? e.message : String(e), message: '运行器异常退出', only: undefined, resumeTo: undefined }); }).finally(() => {
      this.loop = null;
      if (this.restartAfterStop) { this.restartAfterStop = false; const s = this.state(); if (s.only?.length) this.spawn(); }
    });
  }
  pause(): BatchState { this.pauseRequested = true; this.restartAfterStop = false; this.wake?.(); return this.setState({ status: 'paused', message: '暂停：当前这份填完就停', only: undefined, resumeTo: undefined }); }
  stop(): BatchState { this.stopRequested = true; this.restartAfterStop = false; this.wake?.(); return this.setState({ status: 'stopped', message: '已停止', only: undefined, resumeTo: undefined }); }
  /** 侧车启动时调用：上次还在跑就续上。 */
  resumeIfRunning(): void {
    const s = this.state();
    if (s.status !== 'running' || this.loop) return;
    // 只填模式按原来那几份续（重启不能把它放大成全量批量）
    if (s.only?.length) { this.stopRequested = false; this.pauseRequested = false; this.spawn(); } else this.start();
  }
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

  private async loopBody(): Promise<void> {
    const poll = this.deps.pollMs ?? 3000;
    const [pLo, pHi] = this.deps.pacingMs ?? [20_000, 60_000];
    const concurrency = Math.max(1, this.deps.concurrency ?? 2);
    const queue = new PQueue({ concurrency });
    /** 正在填的：actionId → 网站。同一网站同时只允许一份。 */
    const inFlight = new Map<string, { host: string; title: string; mode: 'start' | 'continue' }>();
    /** 每个网站下一份最早什么时候开始（同站拟人停顿）。 */
    const nextAt = new Map<string, number>();
    const running = () => [...inFlight].map(([actionId, v]) => ({ actionId, title: v.title, host: v.host }));
    const busyHosts = () => new Set([...inFlight.values()].map(v => v.host));
    const launch = (action: ActionQueueItem, mode: 'start' | 'continue') => {
      const host = this.platformOf(action, this.payloadOf(action));
      const job = this.titleOf(action);
      inFlight.set(action.id, { host, title: job, mode });
      void queue.add(async () => {
        try { await this.runOne(action, mode, () => running()); }
        catch (e) { this.log(`runOne ${action.id} threw: ${e instanceof Error ? e.message : String(e)}`); }
        finally {
          inFlight.delete(action.id);
          nextAt.set(host, this.now().getTime() + Math.round(pLo + (this.deps.rng?.() ?? Math.random()) * (pHi - pLo)));
          this.wake?.();
        }
      });
    };

    while (!this.stopRequested) {
      this.pollCommand();
      if (this.pauseRequested) {
        if (inFlight.size) { this.setState({ phase: 'driving', running: running(), message: `暂停中：等正在填的 ${inFlight.size} 份填完` }); await this.idle(poll); continue; }
        this.setState({ status: 'paused', phase: undefined, currentActionId: undefined, running: [], message: '已暂停' }); return;
      }
      if (this.deps.control() === 'human') { this.setState({ phase: 'waiting_control', running: running(), message: '你正在接管浏览器，等待交回' }); await this.idle(poll); continue; }
      const nowMs = this.now().getTime();
      if (nowMs < this.browserDownUntil) { this.setState({ phase: 'waiting_control', running: running(), message: '浏览器没起来，稍后自动重试' }); await this.idle(poll); continue; }
      const blocked = busyHosts();
      const ready = (a: ActionQueueItem) => { const h = this.platformOf(a, this.payloadOf(a)); return !inFlight.has(a.id) && !blocked.has(h) && (nextAt.get(h) ?? 0) <= nowMs && (this.transientCooldown.get(h) ?? 0) <= nowMs; };
      const only = this.only();
      // 先处理等用户处理完的接管（handoff 已 resumed 但动作还在 needs_user）
      // Repos.closeHandoff 会把动作置回 executing，所以 needs_user / executing 都算"等续跑"；只看该动作最近一次接管
      const resumable = this.repos.db.all<ActionQueueItem>(`SELECT a.* FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status IN ('needs_user','executing') AND h.resumed_at IS NOT NULL AND h.paused_at=(SELECT MAX(paused_at) FROM handoff WHERE action_id=a.id) ORDER BY h.resumed_at`)
        .filter(a => !inFlight.has(a.id) && (!only || only.has(a.id)));
      const waiting = this.repos.db.all<{ id: string }>(`SELECT a.id FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status='needs_user' AND h.resumed_at IS NULL`)
        .filter(a => !only || only.has(a.id)).length;
      const q = this.queue();
      for (const a of resumable) {
        if (inFlight.size >= concurrency) break;
        const host = this.platformOf(a, this.payloadOf(a));
        if (busyHosts().has(host) || (this.transientCooldown.get(host) ?? 0) > nowMs) continue;
        launch(a, 'continue');
      }
      for (const a of q) {
        if (inFlight.size >= concurrency) break;
        if (this.deps.riskLocked?.(this.platformOf(a, this.payloadOf(a)))) continue;
        if (!ready(a) || busyHosts().has(this.platformOf(a, this.payloadOf(a)))) continue;
        launch(a, 'start');
      }
      if (inFlight.size) {
        this.setState({ status: 'running', phase: 'driving', running: running(), concurrency, currentActionId: running()[0]?.actionId, currentTitle: running()[0]?.title, message: `正在填写 ${inFlight.size} 份：${running().map(r => r.title).join('、')}` });
        await this.idle(poll);
        continue;
      }
      // 没有在填的
      if (q.length) {
        const lockedAll = q.every(a => this.deps.riskLocked?.(this.platformOf(a, this.payloadOf(a))));
        if (lockedAll) { this.setState({ phase: 'rate_locked', running: [], message: `队列里 ${q.length} 份所在平台都在风险锁中，稍后再试` }); await this.idle(60_000); continue; }
        // 只是同站停顿还没到
        const wait = Math.max(0, Math.min(...q.map(a => (nextAt.get(this.platformOf(a, this.payloadOf(a))) ?? 0) - nowMs)));
        this.setState({ phase: 'pacing', running: [], message: `停 ${Math.max(1, Math.round(wait / 1000))} 秒再投下一份（像真人）` });
        await this.idle(Math.max(wait, 1));
        continue;
      }
      if (waiting > 0 && this.deps.hasBrowser && !this.deps.hasBrowser()) {
        const n = this.requeueStaleHandoffs();
        if (n > 0) { this.setState({ message: `浏览器已关闭，重新打开 ${n} 份等你处理的网申` }); continue; }
      }
      if (waiting > 0 && this.deps.pageGone) {
        const n = this.requeueStaleHandoffs(this.deps.pageGone);
        if (n > 0) { this.setState({ message: `网申页面被关掉了，重新打开 ${n} 份接着办` }); continue; }
      }
      if (waiting > 0) { this.setState({ phase: 'waiting_user', currentActionId: undefined, running: [], message: `有 ${waiting} 份等你在浏览器里处理后交回` }); await this.idle(poll); continue; }
      const finished = this.state();
      if (finished.only?.length) {
        const back = finished.resumeTo ?? 'idle';
        this.setState({ status: back, phase: undefined, currentActionId: undefined, running: [], only: undefined, resumeTo: undefined, message: back === 'idle' ? '你批准的网申已处理完' : `你批准的网申已处理完，批量投递仍是${back === 'paused' ? '暂停' : '停止'}状态` });
        return;
      }
      this.setState({ status: 'idle', phase: undefined, currentActionId: undefined, running: [], message: '队列已空，全部处理完' });
      return;
    }
    // stop：不再开新的；正在填的那几份让它们填完当前步骤（drive 本身不可中断），状态先置 stopped
    this.setState({ status: 'stopped', phase: undefined, currentActionId: undefined, running: running(), message: inFlight.size ? `已停止：正在填的 ${inFlight.size} 份填完当前页就结束` : '已停止' });
    await queue.onIdle();
    this.setState({ status: 'stopped', running: [] });
  }

  private titleOf(action: ActionQueueItem): string {
    const payload = this.payloadOf(action);
    const job = typeof payload.job_id === 'string' ? this.repos.getJob(payload.job_id) : undefined;
    return job ? `${job.company_name ?? ''} ${job.title}`.trim() : String(payload.url ?? action.id);
  }

  /**
   * 浏览器已经不在时，等用户处理的接管页面也没了：关掉这些接管，把动作放回队列（approved），
   * 下一轮按 start 模式从岗位网址重新打开；遇到验证码会生成新的、页面还在的接管。等登录的留着，由登录之旅打开。
   */
  requeueStaleHandoffs(pageGone?: NonNullable<BatchRunnerDeps['pageGone']>): number {
    const stale = this.repos.db.all<{ action_id: string; application_id: string | null; handoff_id: string; reason: string }>(
      `SELECT a.id AS action_id, a.application_id, h.id AS handoff_id, h.reason FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.kind='fill_form' AND a.status='needs_user' AND h.resumed_at IS NULL`,
    );
    const actions = new Set<string>();
    // 只填那几份时只动那几份（2026-11-03：「只跑中车」时把别家 11 份页面已关的接管也放回队列，之后批量一开全量就整批重开）
    const only = this.only();
    for (const row of stale) {
      if (only && !only.has(row.action_id)) continue;
      // 等登录的不重开：登录之旅轮到它时自己打开那一家（2026-11-03：每次重启几十家等登录的被整批重开重填，撞同一面登录墙）
      if (row.reason === 'login') continue;
      // 只看页面没了的那几份；缺信息的不靠页面（在等你条里填），页面关了也不用重开
      if (pageGone && (row.reason === 'missing_info' || !pageGone({ id: row.action_id, application_id: row.application_id }))) continue;
      try { this.repos.closeHandoff(row.handoff_id, pageGone ? 'page_closed' : 'browser_closed'); } catch { /* 已关闭 */ }
      actions.add(row.action_id);
    }
    for (const id of actions) this.repos.requeueAction(id);
    if (actions.size) {
      this.log(`requeued ${actions.size} stale handoff action(s): ${pageGone ? 'page closed' : 'browser closed'}`);
      this.deps.broadcast('career:data-changed', { sessionId: this.deps.sessionId?.() ?? 'global', tables: ['handoff', 'action_queue'] });
    }
    return actions.size;
  }

  /**
   * 站点侧的瞬时错误（导航失败、引擎启动失败）按动作计次；浏览器被占用、用户接管这类不是站点的问题，不计。
   * 达到上限返回 true；成功跑过一次（没有这两类错误）就清零。只记在内存里：重启后重新给几次机会。
   */
  private siteKeepsFailing(actionId: string, line: { code?: unknown; status?: unknown }): boolean {
    const siteSide = line.code === 'NAVIGATION_FAILED' || line.status === 503;
    if (!siteSide) { this.siteFailures.delete(actionId); return false; }
    const n = (this.siteFailures.get(actionId) ?? 0) + 1;
    if (n >= MAX_SITE_RETRIES) { this.siteFailures.delete(actionId); return true; }
    this.siteFailures.set(actionId, n);
    return false;
  }

  private payloadOf(a: ActionQueueItem): Record<string, unknown> { try { return JSON.parse(a.payload_json) as Record<string, unknown>; } catch { return {}; } }

  private taskFor(action: ActionQueueItem, payload: Record<string, unknown>, mode: 'start' | 'continue'): Task {
    const existing = mode === 'continue' ? this.repos.db.get<Task>('SELECT * FROM task WHERE kind=? AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1', ['apply', `%"action_id":"${action.id}"%`]) : undefined;
    return existing ?? this.repos.createTask({ title: applyTaskTitle(typeof payload.job_id === 'string' ? this.repos.getJob(payload.job_id) : undefined), kind: 'apply', sessionId: this.deps.sessionId?.() ?? null, payload: { ...payload, action_id: action.id, batch: true } });
  }

  async runOne(action: ActionQueueItem, mode: 'start' | 'continue', running?: () => BatchState['running']): Promise<DriveOutcome> {
    const r = this.repos;
    const payload = this.payloadOf(action);
    const job = typeof payload.job_id === 'string' ? r.getJob(payload.job_id) : undefined;
    const title = job ? `${job.company_name ?? ''} ${job.title}`.trim() : String(payload.url ?? action.id);
    if (mode === 'start') {
      // 认领：对话里的 apply_run 可能已经拿走了这一份；批准后内容变了会退回待审
      const claim = r.claimAction(action.id);
      if (!claim.ok) {
        this.log(`skip ${action.id}: ${claim.reason}`);
        this.deps.broadcast('career:data-changed', { sessionId: this.deps.sessionId?.() ?? 'global', tables: ['action_queue'] });
        return { kind: 'failed', blocked: false, message: claim.reason === 'content_changed' ? '批准后内容有变化，已退回待审' : '已被其他执行者认领' };
      }
    }
    const task = this.taskFor(action, payload, mode);
    r.updateTask(task.id, { status: 'running' });
    if (mode === 'continue') r.setActionStatus(action.id, 'executing');
    if (action.application_id) { try { r.transition(action.application_id, 'pending', mode === 'start' ? '批量投递开始' : '批量投递续跑'); } catch { /* 已在执行态 */ } }
    const changed = (...tables: string[]) => this.deps.broadcast('career:data-changed', { sessionId: this.deps.sessionId?.() ?? 'global', tables });
    changed('task', 'action_queue', 'application');
    this.setState({ status: this.state().status === 'stopped' ? 'stopped' : 'running', phase: 'driving', currentActionId: action.id, currentTitle: title, ...(running ? { running: running() } : {}), message: `${mode === 'start' ? '正在填写' : '继续填写'}：${title}` });
    const runId = `run_${action.id}`;
    const takeover = (state: string, extra: Record<string, unknown> = {}) => this.deps.broadcast('career:takeover', { sessionId: this.deps.sessionId?.() ?? 'global', runId, state, taskId: task.id, ...extra });
    takeover('running', { url: payload.url });
    const events: DriveEvent[] = [];
    // 链接是聚合站的岗位页（不是官网）：不在那上面「填表」，如实记失败，不把站点标语当缺项推给他；重试也没用，不自动再试
    const aggregator = mode === 'start' ? aggregatorHostOf(typeof payload.url === 'string' ? payload.url : null) : null;
    try {
      if (aggregator) { this.log(`aggregator-link ${action.id}: ${aggregator}`); throw new Error(`岗位链接是招聘聚合站 ${aggregator} 的页面，不是公司官网的投递入口`); }
      const file = await this.deps.resumeFileFor?.(payload);
      if (file?.error) throw new Error(file.error);
      const resumePath = file?.path;
      let learnFrom: string[] | undefined;
      if (mode === 'continue') {
        try { const prev = JSON.parse(action.result_json ?? 'null') as { needsUser?: Array<{ label?: string }> } | null; learnFrom = (prev?.needsUser ?? []).map(p => p.label).filter((l): l is string => typeof l === 'string' && !!l); } catch { /* ignore */ }
      }
      await this.deps.drive({ action, payload, mode, resumePath, ...(learnFrom?.length ? { learnFrom } : {}) }, ev => {
        events.push(ev);
        if (ev.type === 'progress') this.deps.broadcast('career:progress', { sessionId: this.deps.sessionId?.() ?? 'global', runId, taskId: task.id, phase: 'apply_batch', message: String(ev.message ?? ''), company: job?.company_name ?? undefined, job_title: job?.title ?? undefined, ...(action.application_id ? { application_id: action.application_id } : {}), ...(typeof ev.progress === 'number' ? { progress: ev.progress } : {}) });
      });
    } catch (e) {
      // 保留错误名（code）：接管冲突 / 宿主停机 / 会话消失要靠它分诊成"暂时不可用"，而不是判死这份网申
      events.push({ type: 'error', status: 500, error: e instanceof Error ? e.message : String(e), ...(e instanceof Error && e.name !== 'Error' ? { code: e.name } : {}) });
    }
    // 瞬时 / 可抢占（浏览器被对话占用、用户接管、宿主停机、会话消失、501/503）：放回队列，不算失败、不占当天名额
    const transientLine = events.find(e => e.type === 'error') as { code?: unknown; status?: unknown; error?: unknown } | undefined;
    if (transientLine && this.siteKeepsFailing(action.id, transientLine)) {
      // 站点这边连着打不开：不再当瞬时重排，交给下面按失败落库（如实告诉用户这一家打不开）
      transientLine.code = undefined;
      transientLine.status = 502;
      transientLine.error = `连续 ${MAX_SITE_RETRIES} 次打不开这家网申页面：${String(transientLine.error ?? '')}`;
    }
    if (events.some(e => e.type === 'error') && isTransientDriveError(transientLine)) {
      if (mode === 'start') r.requeueAction(action.id); else r.setActionStatus(action.id, 'needs_user');
      r.updateTask(task.id, { status: 'queued' });
      takeover('idle');
      changed('task', 'action_queue');
      // 同站冷却：被占用 / 暂不可用时立刻重试只会每 3 秒空转一轮（resumable 队列不看 nextAt），压一压再试
      this.transientCooldown.set(this.platformOf(action, payload), this.now().getTime() + 15_000);
      if (isBrowserDown(transientLine)) { this.browserDownUntil = this.now().getTime() + BROWSER_DOWN_BACKOFF_MS; this.log(`browser-down ${action.id}: ${String(transientLine?.error ?? '')}`); }
      this.setState({ phase: 'waiting_control', message: '浏览器暂时不可用 / 被占用，稍后自动继续' });
      return { kind: 'transient', code: typeof transientLine?.code === 'string' ? transientLine.code : undefined, message: String((transientLine as { error?: unknown } | undefined)?.error ?? '暂时不可用') };
    }
    const outcome = persistDriveOutcome({
      repos: r, action, taskId: task.id, events, changed, mode,
      review: (ids, kind, summary, data) => this.deps.broadcast('career:review', { sessionId: this.deps.sessionId?.() ?? 'global', actionIds: ids, kind, summary, ...(data ? { data } : {}) }),
    });
    if (mode === 'start') this.bumpToday();
    const s = this.state();
    if (outcome.kind === 'handoff') {
      takeover('paused', { reason: outcome.reason, handoffId: outcome.handoffId, url: outcome.finalUrl, message: outcome.userAction ?? outcome.message });
      this.setState({ handoffs: s.handoffs + 1, phase: 'waiting_user', message: `「${title}」需要你处理：${outcome.userAction ?? outcome.message}` });
      this.log(`handoff ${action.id}: ${outcome.reason}`);
    } else if (outcome.kind === 'done') {
      takeover('idle');
      this.setState({ done: s.done + 1, message: `「${title}」${outcome.headline}，${outcome.autoApproved ? '正在提交' : '等你批准提交'}` });
    } else if (outcome.kind === 'failed') {
      takeover('idle');
      // 失败一次先自动再试一次（放回队列，循环还在跑会接着拿到它）；再失败交给等你「N 家没填成」
      const retry = aggregator ? 'not_retryable' : autoRetryFailedFill(r, action.id);
      this.log(`fill failed ${action.id}: retry=${retry}`);
      if (retry === 'retrying') changed('action_queue', 'application');
      this.setState({ failed: s.failed + 1, lastError: outcome.message, message: `「${title}」${outcome.blocked ? '被阻塞' : '失败'}：${outcome.message}${retry === 'retrying' ? '，稍后再试一次' : ''}` });
    }
    return outcome;
  }
}
