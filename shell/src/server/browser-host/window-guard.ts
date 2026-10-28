/**
 * macOS 焦点守卫 + 隐藏兜底（native/career-window-helper.m 的 guard 模式）。
 *
 * 托管 Chrome 每次启动、开新页、网页弹窗都会被系统激活成前台应用：哪怕窗口在看不见的虚拟屏上，
 * 用户正在打的字也会落进网页里。守卫按 --user-data-dir 认领托管 Chrome（绝不碰用户自己的 Chrome），
 * 一被激活就把焦点还给之前的应用（2026-10-26 实测 5–15ms，肉眼只见前台窗口的红绿灯闪一下灰）。
 *
 * hidden：隐藏整个托管 Chrome——虚拟屏不可用时的兜底。实测隐藏后 DOM、点击、计时器照常，页面仍报
 * visibilityState=visible；只是 Chrome 不再合成画面，截图改走 fromSurface:false（page-control.ts）。
 * 隐藏必须用 NSRunningApplication（助手里做）：osascript 隐藏的应用一开新页就被系统取消隐藏。
 * paused：用户临时放出真实窗口时不守卫、不隐藏。
 * 助手意外退出会自动重启并重放状态（新助手按启动参数认领已在运行的 Chrome）。
 */
import { resolveWindowHelper, spawnHelper, type HelperEvent, type HelperProcess } from './window-helper-binary';

export interface ManagedWindowState { hidden: boolean; paused: boolean }

export interface WindowGuardOptions {
  binDir: string;
  log?: (msg: string) => void;
  resolveBinary?: (binDir: string) => Promise<string>;
  spawn?: typeof spawnHelper;
}

const MAX_RESTARTS = 5;

export class WindowGuard {
  private proc: HelperProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly managed = new Map<string, ManagedWindowState>();
  private stopped = false;
  private restarts = 0;
  private onReady: (() => void) | null = null;
  private readonly probes = new Map<string, (result: { pid: number; hidden: boolean; front: number }) => void>();
  constructor(private readonly opts: WindowGuardOptions) {}

  /** 启动 Chrome 之前调用：认领这个 profile 的 Chrome。助手起不来就抛错（调用方只记日志）。 */
  async expect(dir: string, state: Partial<ManagedWindowState> = {}): Promise<void> {
    const next = { hidden: false, paused: false, ...this.managed.get(dir), ...state };
    this.managed.set(dir, next);
    this.stopped = false;
    await this.ensure();
    this.replay(dir, next);
  }

  setHidden(dir: string, hidden: boolean): void {
    const state = this.managed.get(dir);
    if (!state) return;
    state.hidden = hidden;
    this.proc?.send(`hidden ${hidden ? 1 : 0} ${dir}`);
  }

  setPaused(dir: string, paused: boolean): void {
    const state = this.managed.get(dir);
    if (!state) return;
    state.paused = paused;
    this.proc?.send(`pause ${paused ? 1 : 0} ${dir}`);
  }

  forget(dir: string): void {
    if (!this.managed.delete(dir)) return;
    this.proc?.send(`forget ${dir}`);
  }

  state(dir: string): ManagedWindowState | null {
    const state = this.managed.get(dir);
    return state ? { ...state } : null;
  }

  /** 只读：托管 Chrome 此刻是否隐藏、前台是哪个进程（排障 / 冒烟用）。 */
  probe(dir: string, timeoutMs = 2000): Promise<{ pid: number; hidden: boolean; front: number } | null> {
    if (!this.proc) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.probes.delete(dir); resolve(null); }, timeoutMs);
      this.probes.set(dir, result => { clearTimeout(timer); resolve(result); });
      this.proc?.send(`probe ${dir}`);
    });
  }

  /** 助手是否在运行（隐藏兜底依赖它：没有守卫就不能藏）。 */
  running(): boolean { return this.proc !== null; }

  stop(): void {
    this.stopped = true;
    this.managed.clear();
    const proc = this.proc;
    this.proc = null;
    proc?.close();
  }

  private replay(dir: string, state: ManagedWindowState): void {
    this.proc?.send(`expect ${state.hidden ? 1 : 0} ${dir}`);
    if (state.paused) this.proc?.send(`pause 1 ${dir}`);
  }

  private ensure(): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const bin = await (this.opts.resolveBinary ?? resolveWindowHelper)(this.opts.binDir);
      const proc = (this.opts.spawn ?? spawnHelper)(bin, ['guard'], event => this.onEvent(event));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.onReady = null; proc.close(); reject(new Error('焦点守卫没有回应')); }, 5000);
        this.onReady = () => { clearTimeout(timer); this.onReady = null; resolve(); };
        proc.child.once('exit', code => {
          clearTimeout(timer);
          if (this.onReady) { this.onReady = null; reject(new Error(`焦点守卫退出（${String(code)}）`)); }
          if (this.proc === proc) this.proc = null;
          this.scheduleRestart();
        });
      });
      this.proc = proc;
      this.opts.log?.('焦点守卫就绪');
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private scheduleRestart(): void {
    if (this.stopped || this.managed.size === 0 || this.restarts >= MAX_RESTARTS) return;
    this.restarts += 1;
    this.opts.log?.(`焦点守卫意外退出，第 ${this.restarts} 次重启`);
    const timer = setTimeout(() => {
      if (this.stopped) return;
      void this.ensure()
        .then(() => { for (const [dir, state] of this.managed) this.replay(dir, state); })
        .catch(error => this.opts.log?.(`焦点守卫重启失败：${error instanceof Error ? error.message : String(error)}`));
    }, 500 * this.restarts);
    timer.unref?.();
  }

  private onEvent(event: HelperEvent): void {
    if (event.ev === 'ready') { this.onReady?.(); return; }
    if (event.ev === 'probe' && typeof event.dir === 'string') {
      const done = this.probes.get(event.dir);
      this.probes.delete(event.dir);
      done?.({ pid: Number(event.pid), hidden: Boolean(event.hidden), front: Number(event.front) });
      return;
    }
    if (event.ev === 'adopted') this.opts.log?.(`认领托管 Chrome pid=${String(event.pid)}`);
    else if (event.ev === 'refocused') this.opts.log?.(`托管 Chrome 抢焦点，已还给 pid=${String(event.to)}`);
  }
}
