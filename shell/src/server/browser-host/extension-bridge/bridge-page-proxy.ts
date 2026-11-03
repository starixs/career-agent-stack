import type { Page } from 'playwright'
import { humanClick, humanType, warmUpInput, type CdpSessionLike } from '@career/captcha'
import type { BridgeTab } from './extension-bridge'
import type { BridgeLike } from './bridge-driver'

/**
 * BridgePageProxy：把用户真实 Chrome 的一个标签页包装成 playwright `Page`
 * 的子集（browse / apply 引擎实际用到的面），后端全走扩展桥：
 *   evaluate（字符串表达式 ←→ 桥 executeJs 主世界执行，语义同构）
 *   goto / goBack / goForward（location + readyState 轮询）
 *   mouse / keyboard（CDP `Input` 域三事件可信输入；首次使用时持久 attach）
 *   fill / click / selectOption / setInputFiles（页内 JS + 可信点击；文件上传走
 *     DataTransfer——TMWebDriver SOP 的结论：比 CDP setFileInputFiles 稳）
 *   screenshot（CDP Page.captureScreenshot，支持 clip）
 *   once('popup')（tabs_update 新增标签近似）
 * 黄条策略：持久 attach 只发生在"工作标签页"上（自动化运行期），close() 即 detach。
 * 「一体两面」：同一个 tab，产品内侧栏看（screencast 帧流），外面看（真实 Chrome 窗口）。
 */

/** 桥事件源（真实 ExtensionBridge 有；测试 fake 可不给）。 */
export interface BridgeTabsSource {
  onTabsChange(cb: (tabs: BridgeTab[]) => void): () => void
}

const NAV_GONE_HINT = 'Execution context was destroyed / target navigated'
const READY_POLL_MS = 200
const GOTO_TIMEOUT_MS = 20_000

interface ProxyDeps {
  bridge: BridgeLike
  tabs?: BridgeTabsSource
  sleep?: (ms: number) => Promise<void>
  rand?: () => number
}

export class BridgePageProxy {
  private closed = false
  private cdpAttached: Promise<CdpSessionLike> | null = null
  private readonly frameIdentity = { bridgeTab: 0 }
  private readonly popups: Array<(page: Page) => void> = []
  private readonly sleep: (ms: number) => Promise<void>
  private readonly rand: () => number

  constructor(
    private readonly deps: ProxyDeps,
    public tab: BridgeTab,
    private readonly detach: () => void,
  ) {
    this.frameIdentity.bridgeTab = tab.id
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.rand = deps.rand ?? Math.random
  }

  // ---- 身份 / 生命周期（app-pages / page-follower 用 mainFrame 做跨借用稳定身份）----

  mainFrame(): object { return this.frameIdentity }
  isClosed(): boolean { return this.closed }
  url(): string { return this.tab.url }
  async title(): Promise<string> {
    return (await this.evaluateRaw<string>('return document.title || ""')) ?? ''
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.detach()
    await this.deps.bridge.sendCommand({ cmd: 'tabs', method: 'close', tabId: this.tab.id }).catch(() => {})
  }

  /** 把工作标签页拉到前台（"到外面看"：真实 Chrome 窗口切到这一页）。 */
  async bringToFront(): Promise<void> {
    await this.deps.bridge.sendCommand({ cmd: 'tabs', method: 'switch', tabId: this.tab.id }).catch(() => {})
  }

  // ---- 求值（browse 的 inPage 本来就是函数转字符串表达式，语义同构）----

  async evaluate<T = unknown>(expr: string | ((arg: never) => T), arg?: unknown): Promise<T> {
    if (typeof expr === 'string') return this.evaluateRaw<T>(expr)
    const src = `(() => { const __name = (f) => f; return (${expr.toString()})(${JSON.stringify(arg ?? null)}); })()`
    return this.evaluateRaw<T>(src)
  }

  private async evaluateRaw<T>(code: string): Promise<T> {
    if (this.closed) throw new Error('Page is closed')
    try {
      const res = await this.deps.bridge.executeJs(this.tab.id, code)
      return res.data as T
    } catch (error) {
      // 导航中上下文销毁：附上 browse.ts CONTEXT_GONE_RX 认得的关键词，让 inPage 的重试逻辑接住
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`${msg} (${NAV_GONE_HINT})`)
    }
  }

  // ---- 导航 ----

  async goto(url: string): Promise<void> {
    await this.evaluateRaw(`window.location.href = ${JSON.stringify(url)}`)
    // 只等 readyState：导航中上下文销毁由 evaluate 的错误重试兜底（browse inPage 已有）。
    // tab.url 的新值要等扩展 tabs_update 推来，不能在这里强等。
    await this.waitForLoadStateWithTimeout(GOTO_TIMEOUT_MS)
  }

  async goBack(): Promise<void> { await this.evaluateRaw('history.back(); return true') }
  async goForward(): Promise<void> { await this.evaluateRaw('history.forward(); return true') }

  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
    const want = state === 'domcontentloaded' ? 'interactive' : 'complete'
    await this.waitForLoadStateWithTimeout(10_000, want)
  }

  private async waitForLoadStateWithTimeout(timeoutMs: number, want: 'interactive' | 'complete' = 'complete'): Promise<void> {
    const t0 = Date.now()
    for (;;) {
      const state = await this.evaluateRaw<string>('return document.readyState').catch(() => '' as string)
      if (state === 'complete' || (want === 'interactive' && (state === 'interactive' || state === 'complete'))) return
      if (Date.now() - t0 > timeoutMs) return // 到点放行：调用方有自己的观察/重试
      await this.sleep(READY_POLL_MS)
    }
  }

  async waitForTimeout(ms: number): Promise<void> { await this.sleep(ms) }

  // ---- 内容 / 截图 ----

  async content(): Promise<string> {
    return (await this.evaluateRaw<string>('return document.documentElement.outerHTML')) ?? ''
  }

  async screenshot(opts: { clip?: { x: number; y: number; width: number; height: number }; type?: string; quality?: number } = {}): Promise<Buffer> {
    const params: Record<string, unknown> = { format: 'jpeg', quality: opts.quality ?? 45 }
    if (opts.clip) params.clip = { ...opts.clip, scale: 1 }
    const shot = await this.ensureCdp().send('Page.captureScreenshot', params) as { data: string }
    return Buffer.from(shot.data, 'base64')
  }

  // ---- 可信输入（CDP Input 域；首次使用持久 attach——黄条只出现在这个工作标签页）----

  private ensureCdp(): CdpSessionLike {
    this.cdpAttached ??= this.deps.bridge
      .sendCommand({ cmd: 'cdp_attach', tabId: this.tab.id })
      .then(() => {
        const session: CdpSessionLike = {
          send: (method: string, params?: Record<string, unknown>) =>
            this.deps.bridge.sendCommand({ cmd: 'cdp', tabId: this.tab.id, method, params: params ?? {} }),
        }
        // 首次 attach 的坐标预热（infobar 推页面 ~20px 的坑，TMWebDriver 实测结论）
        void warmUpInput({ cdp: session, sleep: this.sleep }).catch(() => {})
        return session
      })
    return pendingSession(this.cdpAttached)
  }

  readonly mouse = {
    click: async (x: number, y: number) => { await humanClick({ cdp: this.ensureCdp(), rand: this.rand, sleep: this.sleep }, x, y) },
    move: async (x: number, y: number) => {
      await this.ensureCdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    },
    down: async () => { await this.ensureCdp().send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1 }) },
    up: async () => { await this.ensureCdp().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1 }) },
  }

  readonly keyboard = {
    type: async (text: string, opts?: { delay?: number }) => {
      await humanType({ cdp: this.ensureCdp(), rand: this.rand, sleep: this.sleep }, text)
      void opts
    },
    press: async (key: string) => {
      const vk = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key.charCodeAt(0) || 13
      const cdp = this.ensureCdp()
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    },
  }

  // ---- DOM 操作（apply 的 PageLike 底层面）----

  async fill(selector: string, value: string): Promise<void> {
    const ok = await this.evaluateRaw<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus?.();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!ok) throw new Error(`找不到要填的元素: ${selector}`)
  }

  async click(selector: string): Promise<void> {
    const rect = await this.rectOf(selector)
    if (!rect) throw new Error(`找不到要点的元素: ${selector}`)
    await this.scrollIntoViewIfNeeded(selector)
    const fresh = (await this.rectOf(selector)) ?? rect
    await this.mouse.click(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2)
  }

  async selectOption(selector: string, value: string | { label: string }): Promise<void> {
    // 匹配谓词先在 JS 侧序列化好（value 或 label 二选一），再嵌进探针
    const match = typeof value === 'string'
      ? `o.value === ${JSON.stringify(value)} || o.text === ${JSON.stringify(value)}`
      : `o.text.trim() === ${JSON.stringify(value.label)}`
    const ok = await this.evaluateRaw<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      let hit = -1;
      for (const o of el.options) {
        if (${match}) { hit = o.index; break }
      }
      if (hit < 0) return false;
      el.selectedIndex = hit;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!ok) throw new Error(`选不到选项: ${selector}`)
  }

  /** 文件上传：DataTransfer 纯 JS 方案（TMWebDriver SOP 结论，比 CDP setFileInputFiles 稳）。 */
  async setInputFiles(selector: string, files: string | string[], contents?: Array<{ name: string; type: string; data: string }>): Promise<void> {
    const payload = contents ?? [{ name: 'upload.bin', type: 'application/octet-stream', data: '' }]
    void files
    const ok = await this.evaluateRaw<boolean>(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input || input.type !== 'file') return false;
      const dt = new DataTransfer();
      const files = ${JSON.stringify(payload)};
      for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.data), c => c.charCodeAt(0)).buffer], f.name, { type: f.type || 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    if (!ok) throw new Error(`找不到文件输入框: ${selector}`)
  }

  async setUploadFiles(selector: string, items: Array<{ name: string; type: string; base64: string }>): Promise<void> {
    await this.setInputFiles(selector, items.map(i => i.name), items.map(i => ({ name: i.name, type: i.type, data: i.base64 })))
  }

  locator(selector: string) {
    return {
      count: async () => (await this.evaluateRaw<number>(`return document.querySelectorAll(${JSON.stringify(selector)}).length`)) ?? 0,
      innerText: async () => (await this.evaluateRaw<string>(`return (document.querySelector(${JSON.stringify(selector)})?.innerText) ?? ''`)) ?? '',
      isVisible: async () => (await this.evaluateRaw<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; })()`)) === true,
      first: () => this.locator(selector),
      fill: (v: string) => this.fill(selector, v),
      click: () => this.click(selector),
      selectOption: (v: string | { label: string }) => this.selectOption(selector, v),
      setInputFiles: (f: string | string[]) => this.setInputFiles(selector, f),
    }
  }

  // ---- 事件（popup 近似：tabs_update 新增即认为开新页）----

  once(event: 'popup', cb: (page: Page) => void): void {
    if (event !== 'popup') return
    this.popups.push(cb)
  }

  /** BridgePageProxySet 在 tabs_update 时调用：新增标签触发 popup 回调。 */
  notifyTabAdded(page: BridgePageProxy): void {
    const cbs = this.popups.splice(0)
    for (const cb of cbs) cb(page as unknown as Page)
  }

  private async rectOf(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return this.evaluateRaw<{ x: number; y: number; width: number; height: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`)
  }

  private async scrollIntoViewIfNeeded(selector: string): Promise<void> {
    await this.evaluateRaw(`(() => { document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' }); return true; })()`).catch(() => {})
    await this.sleep(150)
  }
}

function pendingSession(p: Promise<CdpSessionLike>): CdpSessionLike {
  return { send: async (method, params) => (await p).send(method, params) }
}

/**
 * 标签页集合（≈ BrowserContext.pages()）：订阅 tabs_update 保持新鲜；
 * 观察面板（observe 的 tabs）从此显示用户真实浏览器的全部标签页。
 */
export class BridgePageProxySet {
  private readonly proxies = new Map<number, BridgePageProxy>()
  private readonly knownTabs = new Set<number>()
  private readonly pageListeners = new Set<(page: BridgePageProxy) => void>()
  private offTabs: (() => void) | null = null

  constructor(private readonly deps: ProxyDeps) {
    if (deps.tabs) {
      this.offTabs = deps.tabs.onTabsChange(tabs => this.syncTabs(tabs))
    }
  }

  /** context.on('page') 的桥形态：新标签出现（用户开的 / 我们开的）都通知。 */
  onPage(cb: (page: BridgePageProxy) => void): () => void {
    this.pageListeners.add(cb)
    return () => this.pageListeners.delete(cb)
  }

  /**
   * 扮演 playwright BrowserContext 引擎用到的面（pages / newPage / on / off），
   * 让 browse / apply / batch 引擎不改代码跑在用户真实浏览器上。
   */
  toContext(): unknown {
    const set = this
    return {
      pages: () => set.pages(),
      newPage: async () => {
        const created = await set.deps.bridge.sendCommand<{ id?: number; url?: string; title?: string }>(
          { cmd: 'tabs', method: 'create', url: 'about:blank', active: false },
        ).catch(() => null)
        if (!created?.id) throw new Error('桥开新标签失败')
        const proxy = new BridgePageProxy(set.deps, { id: created.id, url: created.url ?? 'about:blank', title: '' }, () => set.proxies.delete(created.id!))
        set.proxies.set(created.id, proxy)
        for (const cb of set.pageListeners) cb(proxy)
        return proxy
      },
      on: (event: string, cb: (page: never) => void) => { if (event === 'page') set.onPage(cb as (page: BridgePageProxy) => void) },
      off: (event: string, cb: (page: never) => void) => { void event; void cb },
    }
  }

  private syncTabs(tabs: BridgeTab[]): void {
    const seen = new Set<number>()
    for (const t of tabs) {
      seen.add(t.id)
      const existing = this.proxies.get(t.id)
      if (existing) { existing.tab = t; continue }
      this.proxies.set(t.id, new BridgePageProxy(this.deps, t, () => this.proxies.delete(t.id)))
      if (this.knownTabs.size > 0) {
        const fresh = this.proxies.get(t.id)!
        this.notifyPopup(fresh)
        for (const cb of this.pageListeners) cb(fresh)
      }
      this.knownTabs.add(t.id)
    }
    for (const [id, proxy] of this.proxies) {
      if (!seen.has(id) && proxy.isClosed() === false) {
        // 标签被用户关掉：只摘索引，不发 tabs close（已经没了）
        this.proxies.delete(id)
      }
    }
  }

  private notifyPopup(page: BridgePageProxy): void {
    for (const proxy of this.proxies.values()) proxy.notifyTabAdded(page)
  }

  pages(): BridgePageProxy[] { return [...this.proxies.values()].filter(p => !p.isClosed()) }

  get(tabId: number): BridgePageProxy | undefined { return this.proxies.get(tabId) }

  /** 按 URL 片段找一页；没有就后台开一页（不抢用户当前标签）。 */
  async openOrFind(urlPattern: string, openUrl: string): Promise<BridgePageProxy | null> {
    const hit = this.pages().find(p => p.url().includes(urlPattern))
    if (hit) return hit
    const created = await this.deps.bridge.sendCommand<{ id?: number; url?: string; title?: string }>(
      { cmd: 'tabs', method: 'create', url: openUrl, active: false },
    ).catch(() => null)
    if (!created?.id) return null
    const proxy = new BridgePageProxy(this.deps, { id: created.id, url: created.url ?? openUrl, title: created.title ?? '' }, () => this.proxies.delete(created.id!))
    this.proxies.set(created.id, proxy)
    await proxy.waitForLoadState('domcontentloaded').catch(() => {})
    return proxy
  }

  dispose(): void { this.offTabs?.(); this.proxies.clear() }
}
