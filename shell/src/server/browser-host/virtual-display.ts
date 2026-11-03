/**
 * macOS 虚拟屏（macOS 缺省开启，`CAREER_BROWSER_WINDOW=corner` 关闭）：用私有 CGVirtualDisplay 建一块看不见的屏幕，
 * 托管 Chrome 只在这块屏上，不占用户桌面的角落；"显示真实窗口"时照旧搬回主屏。屏由原生窗口助手
 * （native/career-window-helper.m 的 display 模式）持有，放在哪由这里决定。
 *
 * 2026-10-11 实测（真实 Chrome）：虚拟屏上画面流 3 秒 28 帧、截图 9–16ms、CDP 点击生效。
 * 放置：虚拟屏只能和别的屏碰一个角，不能共用一段边——共用边鼠标就能滑进这块看不见的屏。
 * 2026-10-26 实测：外接屏在主屏上方时，旧的"主屏左上对角"和外接屏重叠，macOS 把它推到贴着外接屏左边，
 * 鼠标从外接屏往左就消失了。所以按全部屏幕挑位置、放完核对实际结果，屏幕重排后再核对一次。
 * 风险：虚拟屏一消失，macOS 会把上面的窗口搬到主屏正中——所以和托管 Chrome 同生共死：
 * 先关 Chrome 再放屏；助手意外退出（onLost）或重排后挪不开（onUnsafe）时宿主改用隐藏兜底。
 */
import { resolveWindowHelper, spawnHelper, type HelperEvent, type HelperProcess } from './window-helper-binary';

export interface DisplayRect { id: number; x: number; y: number; w: number; h: number; main?: boolean }
export interface VirtualDisplayBounds { displayID: number; x: number; y: number; w: number; h: number }

/** 两块屏是否重叠或共用一段边（只碰一个角不算）。 */
export function touchesAlongEdge(a: DisplayRect, b: DisplayRect): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapX < 0 || overlapY < 0) return false;
  return overlapX > 0 || overlapY > 0;
}

export function isIsolated(self: DisplayRect, others: DisplayRect[]): boolean {
  return others.every(other => !touchesAlongEdge(self, other));
}

/** 候选位置：主屏优先，每块屏的四个对角各一个；只留和所有屏都不共用边的。 */
export function isolatedOrigins(others: DisplayRect[], w: number, h: number): Array<{ x: number; y: number }> {
  const ordered = [...others].sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)));
  const out: Array<{ x: number; y: number }> = [];
  for (const d of ordered) {
    for (const c of [
      { x: d.x - w, y: d.y - h },
      { x: d.x - w, y: d.y + d.h },
      { x: d.x + d.w, y: d.y - h },
      { x: d.x + d.w, y: d.y + d.h },
    ]) {
      if (isIsolated({ id: -1, ...c, w, h }, others) && !out.some(o => o.x === c.x && o.y === c.y)) out.push(c);
    }
  }
  return out;
}

/** 助手的 displays / placed 事件：拆成虚拟屏自己和其余的屏。 */
export function parseDisplays(event: HelperEvent): { self: DisplayRect | null; others: DisplayRect[] } {
  const list = Array.isArray(event.displays) ? event.displays as DisplayRect[] : [];
  const valid = list.filter(d => [d.id, d.x, d.y, d.w, d.h].every(v => typeof v === 'number' && Number.isFinite(v)));
  return { self: valid.find(d => d.id === event.self) ?? null, others: valid.filter(d => d.id !== event.self) };
}

const toBounds = (d: DisplayRect): VirtualDisplayBounds => ({ displayID: d.id, x: d.x, y: d.y, w: d.w, h: d.h });

export interface VirtualDisplayOptions {
  binDir: string;
  width?: number;
  height?: number;
  /** 助手意外退出，虚拟屏没了。 */
  onLost?: () => void;
  /** 屏幕重排后虚拟屏换了位置（仍然安全）：宿主把窗口重新停过去。 */
  onMoved?: (bounds: VirtualDisplayBounds) => void;
  /** 屏幕重排后虚拟屏贴边且挪不开：宿主先把窗口藏好，再 stop()。 */
  onUnsafe?: () => void;
  log?: (msg: string) => void;
  resolveBinary?: (binDir: string) => Promise<string>;
  spawn?: typeof spawnHelper;
}

type Waiter = (event: HelperEvent) => boolean;

export class VirtualDisplay {
  private proc: HelperProcess | null = null;
  private bounds: VirtualDisplayBounds | null = null;
  private starting: Promise<VirtualDisplayBounds> | null = null;
  private stopping = false;
  private replacing = false;
  private waiter: Waiter | null = null;
  private others: DisplayRect[] = [];
  constructor(private readonly opts: VirtualDisplayOptions) {}

  current(): VirtualDisplayBounds | null { return this.bounds; }
  /** 最近一次看到的其余屏幕（日志 / 冒烟核对用）。 */
  otherDisplays(): DisplayRect[] { return this.others; }

  /** 确保虚拟屏存在且不和别的屏共用边；返回它在全局坐标里的位置。 */
  ensure(): Promise<VirtualDisplayBounds> {
    if (this.bounds && this.proc) return Promise.resolve(this.bounds);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const bin = await (this.opts.resolveBinary ?? resolveWindowHelper)(this.opts.binDir);
      this.stopping = false;
      const proc = (this.opts.spawn ?? spawnHelper)(bin, ['display', String(this.opts.width ?? 1366), String(this.opts.height ?? 768)], event => this.onEvent(event));
      this.proc = proc;
      proc.child.once('exit', code => {
        const wasReady = this.bounds !== null;
        if (this.proc === proc) { this.proc = null; this.bounds = null; }
        this.waiter?.({ ev: 'exit', code });
        if (wasReady && !this.stopping) { this.opts.log?.('虚拟屏意外消失'); this.opts.onLost?.(); }
      });
      try {
        const first = await this.next(['displays', 'error'], 8000);
        if (first.ev === 'error') throw new Error(`虚拟屏创建失败：${String(first.error)}`);
        const bounds = await this.place(first);
        this.bounds = bounds;
        this.opts.log?.(`虚拟屏就绪 id=${bounds.displayID} at ${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}`);
        return bounds;
      } catch (error) {
        this.stopping = true;
        proc.close();
        if (this.proc === proc) this.proc = null;
        throw error;
      }
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private next(names: string[], timeoutMs: number): Promise<HelperEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('虚拟屏助手没有回应')); }, timeoutMs);
      this.waiter = event => {
        if (event.ev === 'exit') { clearTimeout(timer); this.waiter = null; reject(new Error(`虚拟屏助手退出（${String(event.code)}）`)); return true; }
        if (!names.includes(event.ev)) return false;
        clearTimeout(timer); this.waiter = null; resolve(event);
        return true;
      };
    });
  }

  private onEvent(event: HelperEvent): void {
    if (this.waiter?.(event)) return;
    if (event.ev === 'displays' && this.bounds) void this.recheck(event);
  }

  /** 当前位置不安全就按候选位置逐个试，放完以系统实际给的位置为准。 */
  private async place(event: HelperEvent): Promise<VirtualDisplayBounds> {
    let { self, others } = parseDisplays(event);
    this.others = others;
    if (!self) throw new Error('助手没报出虚拟屏的位置');
    if (isIsolated(self, others)) return toBounds(self);
    for (const origin of isolatedOrigins(others, self.w, self.h)) {
      this.proc?.send(`place ${origin.x} ${origin.y}`);
      ({ self, others } = parseDisplays(await this.next(['placed'], 5000)));
      this.others = others;
      if (self && isIsolated(self, others)) return toBounds(self);
    }
    throw new Error('找不到和别的屏都不共用边的位置');
  }

  /** 屏幕重排（插拔、调整排列）后核对：还安全就只更新位置，贴边了就挪，挪不开交给宿主。 */
  private async recheck(event: HelperEvent): Promise<void> {
    if (this.replacing) return;
    const { self } = parseDisplays(event);
    if (!self) return;
    this.replacing = true;
    try {
      const bounds = await this.place(event);
      const before = this.bounds;
      this.bounds = bounds;
      if (!before || before.x !== bounds.x || before.y !== bounds.y || before.w !== bounds.w || before.h !== bounds.h) {
        this.opts.log?.(`屏幕重排，虚拟屏移到 ${bounds.x},${bounds.y}`);
        this.opts.onMoved?.(bounds);
      }
    } catch (error) {
      this.opts.log?.(`屏幕重排后虚拟屏贴边且挪不开：${error instanceof Error ? error.message : String(error)}`);
      this.opts.onUnsafe?.();
    } finally {
      this.replacing = false;
    }
  }

  /** 释放虚拟屏：调用方必须先把托管窗口停走 / 关掉 / 藏好（否则 macOS 会把窗口搬到主屏正中）。 */
  stop(): void {
    this.stopping = true;
    const proc = this.proc;
    this.proc = null; this.bounds = null;
    proc?.close();
  }
}

// ---------- 停靠目标（进程内唯一）：有虚拟屏时停到虚拟屏上，没有就退回角落 ----------
let parkTarget: { left: number; top: number; width: number; height: number } | null = null;
export function setVirtualParkTarget(bounds: VirtualDisplayBounds | null): void {
  parkTarget = bounds ? { left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h } : null;
}
export function virtualParkTarget(): { left: number; top: number; width: number; height: number } | null { return parkTarget; }
