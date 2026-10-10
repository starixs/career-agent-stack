import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { VirtualDisplay, setVirtualParkTarget } from './virtual-display';
import { markProfileExitedCleanly } from './profile-hygiene';
import type {
  Browser,
  BrowserContext,
  BrowserType,
  FileChooser,
  Page,
} from 'playwright';

import type { VerifiedBrowserCapability } from './capability-client';
import {
  checkpointBrowserIdentity,
  readBrowserIdentity,
  type BrowserIdentitySnapshot,
  type BrowserIdentityState,
} from './identity-client';
import {
  compileBrowserRuntimeSettings,
  resolveBrowserRuntimePolicy,
  type BrowserRuntimePolicy,
  type CompiledBrowserRuntimeSettings,
} from './runtime-settings';
import { fitPageViewport, parkWindow, type ViewportSize } from './page-control';
import { waitForBrowserResource, type BrowserResourceResolution } from './resource-client';

/** 页面弹出系统选文件框时的回调（内嵌模式下原生框挂在看不见的窗口上，改由产品内选文件）。 */
export type FileChooserListener = (productSessionId: string, chooser: FileChooser) => void;
/**
 * 托管窗口事件（内嵌模式、窗口没被用户放出来时）：Chrome 启动 / 开新页时 macOS 会把它激活、抢走产品窗口的焦点，
 * 宿主据此通知渲染层把焦点拿回来（渲染层自己的窗口 setFocus 不受跨进程激活限制）。
 */
export type BrowserWindowEvent = 'page';
export type BrowserWindowListener = (productSessionId: string, event: BrowserWindowEvent) => void;

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

const CHECKPOINT_DEBOUNCE_MS = 750;
const CONTEXT_REATTACH_GRACE_MS = 15_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 4_000;
const EMPTY_IDENTITY: BrowserIdentitySnapshot = { revision: 0, state: { cookies: [], origins: [] } };

/** 谁在操作浏览器：Agent（默认）或接管中的用户。 */
export type BrowserControl = 'agent' | 'human';

export interface BrowserControlState {
  control: BrowserControl;
  reason: string | null;
  since: number;
}

export const HUMAN_CONTROL_MESSAGE = '用户正在接管浏览器，等待交回';

export function humanControlError(): Error {
  const error = new Error(HUMAN_CONTROL_MESSAGE);
  error.name = 'BROWSER_CONTROL_HUMAN';
  return error;
}

function agentControl(): BrowserControlState {
  return { control: 'agent', reason: null, since: Date.now() };
}

interface ContextEntry {
  context: BrowserContext;
  /** 持久 profile 由 Chrome 自己落盘；identity-store checkpoint 退化为可选旁路。 */
  persistent: boolean;
  control: BrowserControlState;
  identity: BrowserIdentitySnapshot;
  observedIdentityState: BrowserIdentityState;
  selection: { page: Page | null };
  backendPageOrder: Page[];
  checkpointPromise: Promise<void> | null;
  checkpointRequested: boolean;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  closePromise: Promise<void> | null;
  finalizePromise: Promise<void> | null;
  /** 持久 profile 目录；用来按进程号找到这个托管 Chrome（绝不按应用 ID 激活，那会碰到用户自己的 Chrome）。 */
  userDataDir: string | null;
}

/**
 * Playwright MCP owns its backend and calls `close()` when an HTTP connection
 * ends. The underlying Context is instead leased to the Product Session so a
 * replacement Runtime can reattach during the bounded grace window. All
 * operations remain bound to the real Context; only close stays registry-owned.
 */
type Listener = (...args: unknown[]) => unknown;
type Emitter = {
  on?: (event: string | symbol, listener: Listener) => unknown;
  once?: (event: string | symbol, listener: Listener) => unknown;
  addListener?: (event: string | symbol, listener: Listener) => unknown;
  off?: (event: string | symbol, listener: Listener) => unknown;
  removeListener?: (event: string | symbol, listener: Listener) => unknown;
};

function borrowBrowserContext(
  context: BrowserContext,
  selectedPage: () => Page | null,
  observePageOrder: (pages: Page[]) => void,
): BrowserContext {
  const listeners: Array<{
    emitter: Emitter;
    event: string | symbol;
    original: Listener;
    installed: Listener;
  }> = [];
  const routes: Array<{ pattern: unknown; handler: unknown }> = [];
  const pageProxies = new WeakMap<Page, Page>();
  let cleaned = false;

  const removeTrackedListener = (
    emitter: Emitter,
    event: string | symbol,
    original: Listener,
  ): void => {
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      const tracked = listeners[index];
      if (tracked.emitter !== emitter || tracked.event !== event || tracked.original !== original) {
        continue;
      }
      emitter.removeListener?.(event, tracked.installed);
      listeners.splice(index, 1);
    }
  };

  const wrapEmitter = <T extends Emitter>(
    emitter: T,
    transformArgs?: (event: string | symbol, args: unknown[]) => unknown[],
  ): T => new Proxy(emitter, {
    get(target, property, receiver) {
      if (property === 'on' || property === 'once' || property === 'addListener') {
        return (event: string | symbol, listener: Listener) => {
          const installed: Listener = (...args) => {
            if (property === 'once') {
              const index = listeners.indexOf(tracked);
              if (index !== -1) listeners.splice(index, 1);
            }
            return listener(...(transformArgs?.(event, args) ?? args));
          };
          const tracked = { emitter: target, event, original: listener, installed };
          listeners.push(tracked);
          const method = target[property];
          method?.call(target, event, installed);
          return receiver;
        };
      }
      if (property === 'off' || property === 'removeListener') {
        return (event: string | symbol, listener: Listener) => {
          removeTrackedListener(target, event, listener);
          return receiver;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const wrapPage = (page: Page): Page => {
    const existing = pageProxies.get(page);
    if (existing) return existing;
    const proxy = wrapEmitter(page as unknown as Emitter) as unknown as Page;
    pageProxies.set(page, proxy);
    proxy.once('close', () => {
      // Allow every upstream close listener to observe the event before
      // releasing this Page's borrow bookkeeping.
      queueMicrotask(() => {
        for (let index = listeners.length - 1; index >= 0; index -= 1) {
          const tracked = listeners[index];
          if (tracked.emitter !== (page as unknown as Emitter)) continue;
          tracked.emitter.removeListener?.(tracked.event, tracked.installed);
          listeners.splice(index, 1);
        }
        pageProxies.delete(page);
      });
    });
    return proxy;
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const tracked of listeners.splice(0)) {
      tracked.emitter.removeListener?.(tracked.event, tracked.installed);
    }
    for (const route of routes.splice(0)) {
      await Promise.resolve(
        Reflect.apply(context.unroute, context, [route.pattern, route.handler]),
      ).catch(() => {});
    }
  };

  const borrowed = wrapEmitter(
    context as unknown as Emitter,
    (event, args) => event === 'page' && args[0]
      ? [wrapPage(args[0] as Page), ...args.slice(1)]
      : args,
  ) as unknown as BrowserContext;
  return new Proxy(borrowed, {
    get(target, property) {
      if (property === 'close') return cleanup;
      if (property === 'pages') {
        return () => {
          const pages = context.pages();
          const selected = selectedPage();
          const ordered = !selected || !pages.includes(selected)
            ? pages
            : [selected, ...pages.filter(page => page !== selected)];
          observePageOrder(ordered);
          return ordered.map(wrapPage);
        };
      }
      if (property === 'newPage') {
        return async (...args: unknown[]) => wrapPage(
          await Reflect.apply(context.newPage, context, args) as Page,
        );
      }
      if (property === 'route') {
        return async (pattern: unknown, handler: unknown, options?: unknown) => {
          routes.push({ pattern, handler });
          return Reflect.apply(context.route, context, [pattern, handler, options]);
        };
      }
      if (property === 'unroute') {
        return async (pattern: unknown, handler?: unknown) => {
          for (let index = routes.length - 1; index >= 0; index -= 1) {
            if (routes[index].pattern === pattern
              && (handler === undefined || routes[index].handler === handler)) {
              routes.splice(index, 1);
            }
          }
          return Reflect.apply(context.unroute, context, [pattern, handler]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface ConnectionOwner {
  count: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserContextRegistryDependencies {
  readIdentity(signal?: AbortSignal): Promise<BrowserIdentitySnapshot>;
  checkpointIdentity(
    productSessionId: string,
    base: BrowserIdentitySnapshot,
    observedBaseState: BrowserIdentityState,
    state: BrowserIdentityState,
    signal?: AbortSignal,
  ): Promise<BrowserIdentitySnapshot & { conflictCount: number }>;
  loadBrowserType(): Promise<BrowserType>;
  resolveResource(signal?: AbortSignal): Promise<BrowserResourceResolution>;
  onContextClosed(productSessionId: string): void;
  /** 缺省按环境变量与本机 Chrome 探测结果解析；测试注入固定值。 */
  runtimePolicy?: BrowserRuntimePolicy;
}

const DEFAULT_DEPENDENCIES: BrowserContextRegistryDependencies = {
  readIdentity: readBrowserIdentity,
  checkpointIdentity: checkpointBrowserIdentity,
  loadBrowserType: async () => (await import('playwright')).chromium,
  resolveResource: waitForBrowserResource,
  onContextClosed: () => {},
};

export class BrowserContextRegistry {
  private readonly dependencies: BrowserContextRegistryDependencies;
  readonly runtimePolicy: BrowserRuntimePolicy;
  private readonly entries = new Map<string, ContextEntry>();
  private readonly contextPromises = new Map<string, Promise<BrowserContext>>();
  private readonly contextAbortControllers = new Map<string, AbortController>();
  private readonly connectionOwners = new Map<string, ConnectionOwner>();
  /** 还没有 Context 的 Session 上的接管状态（Context 创建时继承）。 */
  private readonly detachedControls = new Map<string, BrowserControlState>();
  /** 接管期间持有的连接租约：防止 15 秒空闲宽限把用户正在用的 Chrome 关掉。 */
  private readonly controlLeases = new Set<string>();
  /**
   * 等用户处理的接管（登录 / 验证码…）期间持有的连接租约：填表引擎跑完后不再借用浏览器，
   * 没有这个租约 15 秒宽限一过 Chrome 就被关掉，用户打开现场时要处理的页面已经没了。
   */
  private readonly handoffLeases = new Set<string>();
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  /** 用户临时放出真实窗口的 Session：新开的页面不再自动停到角落。 */
  private readonly revealedWindows = new Set<string>();
  /** 现场画面框比例对应的页面视口（渲染层上报）：已开和之后新开的页面都按它，停靠窗口也按它放大。 */
  private readonly liveViewports = new Map<string, ViewportSize>();
  private fileChooserListener: FileChooserListener | null = null;

  constructor(dependencies: Partial<BrowserContextRegistryDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.runtimePolicy = dependencies.runtimePolicy ?? resolveBrowserRuntimePolicy();
  }

  hasContext(productSessionId: string): boolean {
    return this.entries.has(productSessionId);
  }

  /**
   * 内嵌模式下拦截系统选文件框（Playwright 注册 filechooser 监听后不再弹原生框），
   * 交给产品内的选文件入口。只影响之后新建 / 已打开的页面。
   */
  setFileChooserListener(listener: FileChooserListener | null): void {
    this.fileChooserListener = listener;
  }

  private windowListener: BrowserWindowListener | null = null;
  /** macOS 虚拟屏（policy.virtualDisplay）：和托管 Chrome 同生共死，见 virtual-display.ts。 */
  private virtualDisplay: VirtualDisplay | null = null;

  /** 启动 Chrome 前确保虚拟屏就绪；失败退回角落停靠（不挡启动）。 */
  private async ensureVirtualDisplay(): Promise<void> {
    if (!this.runtimePolicy.embeddedWindow || !this.runtimePolicy.virtualDisplay) return;
    if (!this.virtualDisplay) {
      this.virtualDisplay = new VirtualDisplay({
        binDir: join(this.runtimePolicy.profileRoot, '..', 'bin'),
        log: msg => console.log(`[browser-host] ${msg}`),
        // 助手意外退出：macOS 会把窗口搬到主屏正中——立刻停回角落
        onLost: () => { setVirtualParkTarget(null); void this.reparkAll(); },
      });
    }
    try {
      setVirtualParkTarget(await this.virtualDisplay.ensure());
    } catch (error) {
      setVirtualParkTarget(null);
      console.warn(`[browser-host] virtual-display=unavailable fallback=corner error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** 把所有没被用户放出来的托管窗口重新停靠（停靠目标变了时）。 */
  private async reparkAll(): Promise<void> {
    for (const [sessionId, entry] of this.entries) {
      if (this.revealedWindows.has(sessionId)) continue;
      for (const page of entry.context.pages()) if (!page.isClosed()) await parkWindow(entry.context, page, { profileDir: entry.userDataDir }).catch(() => false);
    }
  }
  setWindowListener(listener: BrowserWindowListener | null): void {
    this.windowListener = listener;
  }

  /** 这个会话托管 Chrome 的 profile 目录（隔离模式为 null）。 */
  profileDirFor(productSessionId: string): string | null {
    return this.entries.get(productSessionId)?.userDataDir ?? null;
  }

  isWindowRevealed(productSessionId: string): boolean {
    return this.revealedWindows.has(productSessionId);
  }

  /** 记录真实窗口是否被临时放出；收回时把当前所有页面重新停到角落。 */
  async setWindowRevealed(productSessionId: string, revealed: boolean): Promise<void> {
    if (revealed) { this.revealedWindows.add(productSessionId); return; }
    this.revealedWindows.delete(productSessionId);
    const entry = this.entries.get(productSessionId);
    if (!entry || !this.runtimePolicy.embeddedWindow) return;
    for (const page of entry.context.pages()) {
      if (!page.isClosed()) await parkWindow(entry.context, page, { viewport: this.liveViewports.get(productSessionId) });
    }
  }

  liveViewport(productSessionId: string): ViewportSize | undefined {
    return this.liveViewports.get(productSessionId);
  }

  /**
   * 让这个 Session 的所有页面视口跟随现场画面框的比例；内嵌且窗口没放出来时顺带放大停靠窗口。
   * 没有 Context 时只记下来，浏览器打开后新页面直接用。返回改了几页。
   */
  async setLiveViewport(productSessionId: string, viewport: ViewportSize): Promise<number> {
    this.liveViewports.set(productSessionId, viewport);
    const entry = this.entries.get(productSessionId);
    if (!entry) return 0;
    const park = this.runtimePolicy.embeddedWindow === true && !this.revealedWindows.has(productSessionId);
    let changed = 0;
    for (const page of entry.context.pages()) {
      if (!page.isClosed() && await fitPageViewport(entry.context, page, viewport, { park })) changed++;
    }
    return changed;
  }

  getControl(productSessionId: string): BrowserControlState {
    return this.entries.get(productSessionId)?.control
      ?? this.detachedControls.get(productSessionId)
      ?? agentControl();
  }

  /** 处于 human 接管时抛出带中文信息的 `BROWSER_CONTROL_HUMAN`。 */
  assertAgentControl(productSessionId: string): void {
    if (this.getControl(productSessionId).control === 'human') throw humanControlError();
  }

  setControl(
    productSessionId: string,
    control: BrowserControl,
    reason?: string,
  ): BrowserControlState {
    const state: BrowserControlState = {
      control,
      reason: reason?.trim() ? reason.trim() : null,
      since: Date.now(),
    };
    const entry = this.entries.get(productSessionId);
    if (entry) entry.control = state;
    else this.detachedControls.set(productSessionId, state);
    if (control === 'human' && !this.controlLeases.has(productSessionId)) {
      this.controlLeases.add(productSessionId);
      this.retainConnection(productSessionId);
    } else if (control === 'agent' && this.controlLeases.delete(productSessionId)) {
      this.releaseConnection(productSessionId);
    }
    console.info(
      `[browser-host] control=${control} reason=${state.reason ?? '-'}`,
    );
    return state;
  }

  /** 有未关闭的接管时持有浏览器（幂等）；接管全部关闭后释放，回到正常的空闲回收。 */
  setHandoffHold(productSessionId: string, held: boolean): void {
    if (held && !this.handoffLeases.has(productSessionId)) {
      this.handoffLeases.add(productSessionId);
      this.retainConnection(productSessionId);
    } else if (!held && this.handoffLeases.delete(productSessionId)) {
      this.releaseConnection(productSessionId);
    }
  }

  hasHandoffHold(productSessionId: string): boolean {
    return this.handoffLeases.has(productSessionId);
  }

  retainConnection(productSessionId: string): void {
    const owner = this.connectionOwners.get(productSessionId) ?? { count: 0, releaseTimer: null };
    if (owner.releaseTimer) {
      clearTimeout(owner.releaseTimer);
      owner.releaseTimer = null;
    }
    owner.count += 1;
    this.connectionOwners.set(productSessionId, owner);
  }

  releaseConnection(productSessionId: string): void {
    const owner = this.connectionOwners.get(productSessionId);
    if (!owner) return;
    owner.count = Math.max(0, owner.count - 1);
    this.scheduleContextRelease(productSessionId, owner);
  }

  private scheduleContextRelease(productSessionId: string, owner: ConnectionOwner): void {
    if (owner.count > 0 || owner.releaseTimer) return;
    owner.releaseTimer = setTimeout(() => {
      const current = this.connectionOwners.get(productSessionId);
      if (current !== owner || current.count > 0) return;
      this.connectionOwners.delete(productSessionId);
      void this.closeSessionContext(productSessionId).catch(error => {
        console.warn(
          `[browser-host] context=release-failed error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        if (!this.entries.has(productSessionId) || this.connectionOwners.has(productSessionId)) {
          return;
        }
        const retryOwner: ConnectionOwner = { count: 0, releaseTimer: null };
        this.connectionOwners.set(productSessionId, retryOwner);
        this.scheduleContextRelease(productSessionId, retryOwner);
      });
    }, CONTEXT_REATTACH_GRACE_MS);
    owner.releaseTimer.unref?.();
  }

  /** Cancel only an in-flight Context/lease acquisition for this Session. */
  cancelPendingContext(productSessionId: string): void {
    this.contextAbortControllers.get(productSessionId)?.abort();
  }

  /**
   * Move one live MCP connection, and any Context it already owns, from the
   * provisional Session id to Rust's canonical id. A collision is rejected so
   * two independently-created Contexts are never guessed into one owner.
   */
  rekeyProductSession(previousId: string, nextId: string): boolean {
    if (previousId === nextId) return true;
    if (this.contextPromises.has(previousId) || this.contextPromises.has(nextId)) return false;
    const previousEntry = this.entries.get(previousId);
    if (previousEntry && (this.entries.has(nextId) || previousEntry.closePromise)) return false;

    const previousOwner = this.connectionOwners.get(previousId);
    if (!previousOwner || previousOwner.count < 1) return false;
    if (previousOwner.releaseTimer) {
      clearTimeout(previousOwner.releaseTimer);
      previousOwner.releaseTimer = null;
    }
    // A human-takeover lease is one counted connection of the provisional
    // owner; it follows the adoption together with the live MCP connection.
    // 接管等待期的租约同理随会话迁移
    const movedControl = this.controlLeases.delete(previousId);
    const movedHandoff = this.handoffLeases.delete(previousId);
    const movedConnections = 1 + (movedControl ? 1 : 0) + (movedHandoff ? 1 : 0);
    previousOwner.count = Math.max(0, previousOwner.count - movedConnections);
    if (previousOwner.count === 0) this.connectionOwners.delete(previousId);

    const nextOwner = this.connectionOwners.get(nextId) ?? { count: 0, releaseTimer: null };
    if (nextOwner.releaseTimer) {
      clearTimeout(nextOwner.releaseTimer);
      nextOwner.releaseTimer = null;
    }
    nextOwner.count += movedConnections;
    this.connectionOwners.set(nextId, nextOwner);
    if (movedControl) this.controlLeases.add(nextId);
    if (movedHandoff) this.handoffLeases.add(nextId);

    const detachedControl = this.detachedControls.get(previousId);
    if (detachedControl) {
      this.detachedControls.delete(previousId);
      if (!this.detachedControls.has(nextId)) this.detachedControls.set(nextId, detachedControl);
    }

    if (previousEntry) {
      this.entries.delete(previousId);
      this.entries.set(nextId, previousEntry);
      if (previousEntry.checkpointTimer) {
        clearTimeout(previousEntry.checkpointTimer);
        previousEntry.checkpointTimer = null;
        this.scheduleCheckpoint(nextId);
      }
    }
    return true;
  }

  /**
   * 产品内选中某一页（每份网申一个页面时切换现场画面）。传入的可能是借用代理，
   * 按 mainFrame()（Playwright 缓存的同一个 Frame）找回真实 Page。
   */
  focusPage(productSessionId: string, page: Page): void {
    const entry = this.entries.get(productSessionId);
    // 用户正在接管时不切画面：并行填的其他网申不能把用户正在操作的那一页换走
    if (!entry || entry.control.control === 'human') return;
    const frame = page.mainFrame();
    const real = entry.context.pages().find(candidate => candidate.mainFrame() === frame);
    if (real) entry.selection.page = real;
  }

  reconcileTabAction(
    productSessionId: string,
    action: unknown,
    index: unknown,
  ): void {
    const entry = this.entries.get(productSessionId);
    if (!entry || typeof action !== 'string') return;
    const pages = entry.context.pages();
    const selectedPage = entry.selection.page;
    const previousOrder = entry.backendPageOrder.length > 0
      ? entry.backendPageOrder
      : pages;
    const ordered = [
      ...previousOrder.filter(page => pages.includes(page)),
      ...pages.filter(page => !previousOrder.includes(page)),
    ];
    if (action === 'select' && typeof index === 'number' && Number.isInteger(index)) {
      entry.selection.page = ordered[index] ?? selectedPage;
    } else if (action === 'new') {
      entry.selection.page = ordered.at(-1) ?? selectedPage;
    } else if (action === 'close' && selectedPage && !pages.includes(selectedPage)) {
      const closedIndex = typeof index === 'number' && Number.isInteger(index)
        ? index
        : previousOrder.indexOf(selectedPage);
      entry.selection.page = ordered[Math.min(Math.max(closedIndex, 0), ordered.length - 1)] ?? null;
    }
    entry.backendPageOrder = ordered;
  }

  async getContext(
    binding: VerifiedBrowserCapability,
    signal?: AbortSignal,
  ): Promise<BrowserContext> {
    if (signal?.aborted) throw new Error('BROWSER_CONTEXT_CANCELLED');
    const existing = this.entries.get(binding.productSessionId);
    if (existing) {
      return this.borrowContext(existing);
    }
    const pending = this.contextPromises.get(binding.productSessionId);
    if (pending) {
      const context = await pending;
      const entry = this.entries.get(binding.productSessionId);
      return entry
        ? this.borrowContext(entry)
        : context;
    }

    const abortController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;
    this.contextAbortControllers.set(binding.productSessionId, abortController);
    const promise = this.createContext(
      binding,
      combinedSignal,
    );
    this.contextPromises.set(binding.productSessionId, promise);
    try {
      const context = await promise;
      const entry = this.entries.get(binding.productSessionId);
      return entry
        ? this.borrowContext(entry)
        : context;
    } finally {
      if (this.contextPromises.get(binding.productSessionId) === promise) {
        this.contextPromises.delete(binding.productSessionId);
      }
      if (this.contextAbortControllers.get(binding.productSessionId) === abortController) {
        this.contextAbortControllers.delete(binding.productSessionId);
      }
      if (!this.entries.has(binding.productSessionId)) {
        await this.closeSharedBrowserIfIdle();
      }
    }
  }

  private borrowContext(entry: ContextEntry): BrowserContext {
    return borrowBrowserContext(
      entry.context,
      () => entry.selection.page,
      pages => { entry.backendPageOrder = pages; },
    );
  }

  private async createContext(
    binding: VerifiedBrowserCapability,
    signal?: AbortSignal,
  ): Promise<BrowserContext> {
    if (signal?.aborted) throw new Error('BROWSER_CONTEXT_CANCELLED');
    await this.ensureVirtualDisplay();
    const compiled = compileBrowserRuntimeSettings(
      binding.productSessionId,
      binding.workspacePath,
      this.runtimePolicy,
    );
    const persistent = compiled.userDataDir !== null;

    // 持久 profile 下 identity-store 只用来给全新 profile 预热一次 Cookie，
    // 读不到也不阻塞启动；隔离模式仍是权威来源。
    const identity = persistent
      ? await this.dependencies.readIdentity(signal).catch(error => {
        console.warn(
          `[browser-host] identity=read-skipped mode=persistent error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        return EMPTY_IDENTITY;
      })
      : await this.dependencies.readIdentity(signal);
    const launchOptions = await this.resolveLaunchOptions(compiled, signal);

    let context: BrowserContext;
    let seedCookies: boolean;
    if (compiled.userDataDir) {
      seedCookies = !existsSync(compiled.userDataDir);
      mkdirSync(compiled.userDataDir, { recursive: true });
      // 上次被强杀留下的"崩溃"标记会让 Chrome 弹恢复提示，用户看到的就是"浏览器崩溃了"
      const repaired = markProfileExitedCleanly(compiled.userDataDir);
      console.log(`[browser-host] context=launch mode=persistent channel=${compiled.channel} crash-mark=${repaired ? 'cleared' : 'clean'}`);
      const browserType = await this.dependencies.loadBrowserType();
      context = await browserType.launchPersistentContext(compiled.userDataDir, {
        ...launchOptions,
        ...compiled.contextOptions,
      });
    } else {
      seedCookies = true;
      const browser = await this.getBrowser(launchOptions);
      context = await browser.newContext(compiled.contextOptions);
    }
    console.log(`[browser-host] context=launched mode=${compiled.userDataDir ? 'persistent' : 'isolated'}`);
    context.on('close', () => console.log('[browser-host] context=closed'));
    try {
      await context.addInitScript(compiled.initScript);
      if (seedCookies && identity.state.cookies.length > 0) {
        await context.addCookies(identity.state.cookies as BrowserCookie[]);
      }
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }

    if (signal?.aborted) {
      await context.close();
      const cancelled = new Error('Browser Context creation was cancelled');
      cancelled.name = 'BROWSER_CONTEXT_CANCELLED';
      throw cancelled;
    }

    const selection = { page: null as Page | null };
    const inheritedControl = this.detachedControls.get(binding.productSessionId);
    this.detachedControls.delete(binding.productSessionId);
    const entry: ContextEntry = {
      context,
      persistent,
      control: inheritedControl ?? agentControl(),
      identity,
      observedIdentityState: identity.state,
      selection,
      backendPageOrder: [],
      checkpointPromise: null,
      checkpointRequested: false,
      checkpointTimer: null,
      closePromise: null,
      finalizePromise: null,
      userDataDir: compiled.userDataDir,
    };
    this.entries.set(binding.productSessionId, entry);
    // Selection/order live through MCP disconnect and reattach grace, so their
    // Page-close observer belongs to the real Context, not to a backend borrow.
    const embedded = this.runtimePolicy.embeddedWindow === true;
    const onFileChooser = (chooser: FileChooser) => {
      this.fileChooserListener?.(binding.productSessionId, chooser);
    };
    const observePage = (page: Page) => {
      if (embedded) {
        const parked = !this.revealedWindows.has(binding.productSessionId);
        const viewport = this.liveViewports.get(binding.productSessionId);
        if (viewport) void fitPageViewport(context, page, viewport, { park: parked, profileDir: compiled.userDataDir });
        else if (parked) void parkWindow(context, page, { profileDir: compiled.userDataDir });
        if (parked) this.windowListener?.(binding.productSessionId, 'page');
        page.on('filechooser', onFileChooser);
      }
      page.once('close', () => {
        const index = entry.backendPageOrder.indexOf(page);
        entry.backendPageOrder = entry.backendPageOrder.filter(candidate => candidate !== page);
        if (entry.selection.page === page) {
          const pages = entry.backendPageOrder;
          entry.selection.page = pages[Math.min(Math.max(index, 0), pages.length - 1)] ?? null;
        }
      });
    };
    context.on('page', observePage);
    context.pages().forEach(observePage);
    context.once('close', () => {
      context.off('page', observePage);
      const owner = [...this.entries].find(([, candidate]) => candidate.context === context)?.[0]
        ?? binding.productSessionId;
      void this.finalizeClosedEntry(owner, entry).catch(error => {
        console.warn(
          `[browser-host] context=finalize-failed error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    });
    console.info(
      `[browser-host] context=ready mode=${persistent ? 'persistent-profile' : 'managed-isolated'} channel=${compiled.channel} hostGeneration=${binding.hostGeneration}`,
    );
    return context;
  }

  /** 本机 Chrome 由 Playwright 自己定位；托管 Chromium 才等待 Rust 的资源安装事务。 */
  private async resolveLaunchOptions(
    compiled: CompiledBrowserRuntimeSettings,
    signal?: AbortSignal,
  ): Promise<Parameters<BrowserType['launch']>[0]> {
    if (compiled.channel === 'chrome') return compiled.launchOptions;
    const resource = await this.dependencies.resolveResource(signal);
    return { ...compiled.launchOptions, executablePath: resource.executablePath };
  }

  private async getBrowser(
    launchOptions: Parameters<BrowserType['launch']>[0],
  ): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = this.dependencies.loadBrowserType()
        .then(browserType => browserType.launch(launchOptions))
        .then(browser => {
          this.browser = browser;
          browser.once('disconnected', () => {
            if (this.browser === browser) {
              this.browser = null;
              this.browserPromise = null;
            }
          });
          return browser;
        })
        .catch(error => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  scheduleCheckpoint(productSessionId: string): void {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = null;
      void this.checkpoint(productSessionId).catch(error => {
        console.warn(
          `[browser-host] checkpoint=failed code=BROWSER_IDENTITY_CHECKPOINT_FAILED error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    }, CHECKPOINT_DEBOUNCE_MS);
    entry.checkpointTimer.unref?.();
  }

  async checkpoint(productSessionId: string): Promise<void> {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.checkpointTimer) {
      clearTimeout(entry.checkpointTimer);
      entry.checkpointTimer = null;
    }
    // Chrome's own user-data-dir is the persistence authority for a persistent
    // profile. The identity-store mirror is an opt-in bypass whose failure
    // never blocks a tool or a close; the interface stays the same for callers.
    if (entry.persistent && !this.runtimePolicy.mirrorIdentity) return;
    // A later trigger needs a snapshot taken after that trigger, including
    // final close. Coalesce triggers during a commit into one follow-up read.
    entry.checkpointRequested = true;
    if (entry.checkpointPromise) return entry.checkpointPromise;

    // Assign admission before executing even synchronously failing mocks/APIs.
    entry.checkpointPromise = Promise.resolve().then(async () => {
      try {
        do {
          entry.checkpointRequested = false;
          // `storageState()` materializes every non-visible Web Storage origin in
          // a real Playwright page. In headed Chromium that leaks as a temporary
          // tab cycling through historical sites. Managed Browser identity is
          // therefore deliberately cookie-only and uses page-free cookie APIs.
          const state: BrowserIdentityState = {
            cookies: await entry.context.cookies() as unknown as Array<Record<string, unknown>>,
            origins: [],
          };
          const result = await this.dependencies.checkpointIdentity(
            productSessionId,
            entry.identity,
            entry.observedIdentityState,
            state,
          );
          entry.identity = { revision: result.revision, state: result.state };
          // Diff future checkpoints against what this Context actually held, not
          // against a conflicting value another Session committed to the Store.
          entry.observedIdentityState = state;
          console.info(
            `[browser-host] checkpoint=committed revision=${result.revision} conflictCount=${result.conflictCount}`,
          );
        } while (entry.checkpointRequested);
      } catch (error) {
        if (!entry.persistent) throw error;
        console.warn(
          `[browser-host] checkpoint=mirror-failed mode=persistent error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      } finally {
        // Release ownership in the operation's continuation itself: an outer
        // .finally leaves a microtask gap where a new trigger can join a loop
        // that has already ended and silently lose its required snapshot.
        entry.checkpointPromise = null;
      }
    });
    return entry.checkpointPromise;
  }

  private async checkpointBeforeDestructiveClose(productSessionId: string): Promise<void> {
    try {
      await this.checkpoint(productSessionId);
    } catch {
      try {
        // A retry safely reconciles both transport outcomes: if the first
        // commit reached Rust, CAS returns the authoritative state; if it did
        // not, the same Context state is committed now.
        await this.checkpoint(productSessionId);
      } catch {
        const error = new Error('Browser identity checkpoint could not be confirmed');
        error.name = 'BROWSER_IDENTITY_CHECKPOINT_FAILED';
        throw error;
      }
    }
  }

  private finalizeClosedEntry(productSessionId: string, entry: ContextEntry): Promise<void> {
    if (entry.finalizePromise) return entry.finalizePromise;
    entry.finalizePromise = (async () => {
      if (this.entries.get(productSessionId) === entry) {
        this.entries.delete(productSessionId);
      } else {
        for (const [owner, candidate] of this.entries) {
          if (candidate === entry) {
            this.entries.delete(owner);
            break;
          }
        }
      }
      if (entry.checkpointTimer) {
        clearTimeout(entry.checkpointTimer);
        entry.checkpointTimer = null;
      }
      // The user closing Chrome ends their takeover; the lease must not keep
      // a dead Context's owner alive.
      if (entry.control.control === 'human') this.setControl(productSessionId, 'agent', '浏览器已关闭');
      this.dependencies.onContextClosed(productSessionId);
      await this.closeSharedBrowserIfIdle();
    })();
    return entry.finalizePromise;
  }

  async closeSessionContext(productSessionId: string): Promise<void> {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      let checkpointFailure: unknown;
      try {
        await this.checkpointBeforeDestructiveClose(productSessionId);
      } catch (error) {
        checkpointFailure = error;
        // Browser Identity owns persistence, not Context lifetime. Once the
        // Product Session has asked to retire this exact Context, an identity
        // outage is a bounded data-risk diagnostic and cannot veto close.
        console.warn(
          `[browser-host] checkpoint=failed phase=destructive-close code=BROWSER_IDENTITY_CHECKPOINT_FAILED error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.context.close(),
          new Promise<never>((_resolve, reject) => {
            closeTimeout = setTimeout(
              () => reject(new Error('Browser Context close timed out')),
              CONTEXT_CLOSE_TIMEOUT_MS,
            );
            closeTimeout.unref?.();
          }),
        ]);
      } catch (closeFailure) {
        console.warn(
          `[browser-host] context=close-failed phase=destructive-close checkpoint=${checkpointFailure ? 'failed' : 'committed'} error=${closeFailure instanceof Error ? closeFailure.name : 'unknown'}`,
        );
        const error = new Error('The browser context could not be closed');
        error.name = 'BROWSER_CONTEXT_CLOSE_FAILED';
        throw error;
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
      await this.finalizeClosedEntry(productSessionId, entry);
    })().finally(() => {
      entry.closePromise = null;
    });
    return entry.closePromise;
  }

  private async closeSharedBrowserIfIdle(): Promise<void> {
    if (
      !this.browser
      || this.contextPromises.size > 0
      || this.entries.size > 0
    ) return;
    const browser = this.browser;
    this.browser = null;
    this.browserPromise = null;
    await browser.close().catch(() => {});
  }

  private async resetRuntime(options: {
    preserveConnectionOwners: boolean;
  }): Promise<void> {
    const pendingContexts = [...this.contextPromises.values()];
    for (const controller of this.contextAbortControllers.values()) controller.abort();
    await Promise.allSettled(pendingContexts);
    const closeResults = await Promise.allSettled(
      [...this.entries.keys()].map(sessionId => this.closeSessionContext(sessionId)),
    );
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (closeFailure) throw closeFailure.reason;
    if (!options.preserveConnectionOwners) {
      for (const owner of this.connectionOwners.values()) {
        if (owner.releaseTimer) clearTimeout(owner.releaseTimer);
      }
      this.connectionOwners.clear();
    }
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.browserPromise = null;
    // 窗口都关了才放虚拟屏（反过来 macOS 会把窗口搬到主屏正中）
    if (!options.preserveConnectionOwners && this.virtualDisplay) {
      this.virtualDisplay.stop();
      setVirtualParkTarget(null);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.resetRuntime({
      preserveConnectionOwners: false,
    });
    return this.shutdownPromise;
  }
}
