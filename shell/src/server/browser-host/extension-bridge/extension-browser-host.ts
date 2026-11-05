import type { BrowserContext, Page } from 'playwright'
import { verifyBrowserCapability, type VerifiedBrowserCapability } from '../capability-client'
import type { BrowserControl, BrowserControlState } from '../context-registry'
import { bridgeEngineContext, ensureProductBrowserReady } from './bridge-host'
import type { BridgePageProxy } from './bridge-page-proxy'
import type { FileChooserLike } from '../../career/file-chooser'

type Engine = NonNullable<ReturnType<typeof bridgeEngineContext>>
interface BorrowOptions { allowHumanControl?: boolean; signal?: AbortSignal; create?: { workspacePath: string; hostGeneration?: number } }

/** Global owns the product browser and shared access; personal Chrome is untouched. */
export class ExtensionBrowserHost {
  private control: BrowserControlState = { control: 'agent', reason: null, since: Date.now() }
  private activeAgentBorrows = 0
  private stopping = false
  private fileChooserListener: ((id: string, chooser: FileChooserLike) => void) | null = null
  setFileChooserListener(listener: (id: string, chooser: FileChooserLike) => void): void { this.fileChooserListener = listener }

  constructor(private readonly deps: {
    engine: typeof bridgeEngineContext
    verifyCapability: typeof verifyBrowserCapability
    ready?: (signal?: AbortSignal) => Promise<void>
  } = { engine: bridgeEngineContext, verifyCapability: verifyBrowserCapability, ready: ensureProductBrowserReady }) {}

  async verifyCapability(token: string, signal?: AbortSignal): Promise<VerifiedBrowserCapability> {
    try { return await this.deps.verifyCapability(token, signal) }
    catch (cause) { throw Object.assign(new Error('Browser capability is invalid or expired', { cause }), { name: 'BROWSER_CAPABILITY_INVALID' }) }
  }
  browserChannel(): 'chrome' { return 'chrome' }
  // Embedded is a presentation choice, NOT permission to hide/move the user's window.
  embeddedWindow(): boolean { return true }
  isWindowRevealed(_id: string): boolean { return false }
  hasContext(_id: string): boolean { return !!this.deps.engine() }
  getControl(_id: string): BrowserControlState { return this.control }
  setControl(_id: string, control: BrowserControl, reason?: string): BrowserControlState {
    // There is only one physical browser: a human takeover fences every caller.
    this.control = { control, reason: reason ?? null, since: Date.now() }
    if (control === 'agent' && !this.activeAgentBorrows) void this.deps.engine()?.set.releaseInput()
    return this.control
  }
  setHandoffHold(_id: string, _held: boolean): void { /* Chrome lifetime belongs to its user. */ }
  focusPage(_id: string, page: Page): void {
    const engine = this.deps.engine()
    const proxy = engine?.set.pages().find(p => p.mainFrame() === page.mainFrame())
    if (proxy) engine?.set.focus(proxy)
  }
  async setWindowVisible(_id: string, visible: boolean): Promise<{ revealed: boolean }> {
    if (visible) await this.engine().set.pages()[0]?.bringToFront()
    return { revealed: visible } // false never hides or minimizes the user's Chrome
  }
  async fitLiveViewport(_id: string, _box: { width: number; height: number }) {
    // Keep the real viewport; the renderer letterboxes the frame. Never resize a user's tab.
    return { viewport: null, changed: 0, supported: false }
  }

  private engine(): Engine {
    if (this.stopping) throw Object.assign(new Error('Browser Host is stopping'), { name: 'BROWSER_HOST_STOPPING' })
    const engine = this.deps.engine()
    if (!engine) throw Object.assign(new Error('浏览器尚未自动连通，请稍后重试'), { name: 'BRIDGE_NOT_CONNECTED' })
    return engine
  }

  async withContext<T>(token: string, fn: (context: BrowserContext, binding: VerifiedBrowserCapability) => Promise<T>, options: BorrowOptions = {}): Promise<T> {
    const binding = await this.verifyCapability(token, options.signal)
    return this.withProductSession(binding.productSessionId, context => fn(context, binding), options)
  }

  async withProductSession<T>(id: string, fn: (context: BrowserContext) => Promise<T>, options: BorrowOptions = {}): Promise<T> {
    options.signal?.throwIfAborted()
    if (!options.allowHumanControl && this.control.control === 'human') {
      throw Object.assign(new Error('用户正在接管浏览器，等待交回'), { name: 'BROWSER_CONTROL_HUMAN' })
    }
    if (!this.deps.engine()) await this.deps.ready?.(options.signal)
    options.signal?.throwIfAborted()
    if (!options.allowHumanControl && this.control.control === 'human') {
      throw Object.assign(new Error('用户正在接管浏览器，等待交回'), { name: 'BROWSER_CONTROL_HUMAN' })
    }
    const engine = this.engine()
    engine.set.setFileChooserListener(this.fileChooserListener ? chooser => this.fileChooserListener?.(id, chooser) : null)
    const agent = !options.allowHumanControl
    if (agent) this.activeAgentBorrows++
    try { return await fn(engine.context as BrowserContext) }
    finally {
      if (agent) this.activeAgentBorrows--
      if (agent && !this.activeAgentBorrows && this.control.control !== 'human') await engine.set.releaseInput()
    }
  }

  async retireProductSession(_id: string): Promise<void> {
    // No tab close/profile deletion: those resources are not owned by a product session.
    if (!this.activeAgentBorrows && this.control.control !== 'human') await this.deps.engine()?.set.releaseInput()
  }
  async shutdown(): Promise<void> {
    this.stopping = true
    const engine = this.deps.engine()
    await engine?.set.releaseInput()
    engine?.set.dispose()
  }
}

/** Bridge viewport is asynchronous; Playwright's viewportSize() isn't. */
/** 视口尺寸缓存多久：现场窗每个鼠标事件都要换算坐标，每次都去页面里量一次就多一个往返（2026-11-05 现场窗操作卡顿）。 */
const VIEWPORT_CACHE_MS = 1500
const viewportCache = new WeakMap<Page, { at: number; size: { width: number; height: number } | null }>()

export async function livePageViewport(page: Page): Promise<{ width: number; height: number } | null> {
  const hit = viewportCache.get(page)
  if (hit && Date.now() - hit.at < VIEWPORT_CACHE_MS) return hit.size
  const bridgePage = page as unknown as Partial<BridgePageProxy>
  const size = bridgePage.viewport ? await bridgePage.viewport() : page.viewportSize()
  viewportCache.set(page, { at: Date.now(), size })
  return size
}
