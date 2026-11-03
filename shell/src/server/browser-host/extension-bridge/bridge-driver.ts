import type { CaptchaPage, CdpSessionLike } from '@career/captcha'
import type { BridgeCdpEvent, BridgeTab, ExtensionBridge } from './extension-bridge'

/**
 * BridgeDriver：把扩展桥（用户日常 Chrome 里的 career-bridge）包装成
 * @career/captcha 的 CaptchaPage —— 验证码检测 / 视觉求解 / CDP 可信输入
 * 直接跑在**用户自己的浏览器标签页**上，登录态、Cookie、指纹、历史全部是真的。
 *
 * 这是"以 GenericAgent 方案为主"的主通道：产品里已有的长处（网格化坐标、
 * 站点预算、提交红线、拟人节奏）都建立在这层之上。
 */

/** 桥的最小接口（单测用 fake 替身）。 */
export interface BridgeLike {
  isConnected(): boolean
  tabs(): BridgeTab[]
  findTab(urlPattern: string): BridgeTab | null
  executeJs(tabId: number, code: string, timeoutMs?: number): Promise<{ data: unknown }>
  sendCommand<T = unknown>(cmd: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

/** 事件能力（真实 ExtensionBridge 有；fake 可不给）。 */
export interface BridgeEventSource {
  onCdpEvent(cb: (event: BridgeCdpEvent) => void): () => void
  onDisconnect(cb: () => void): () => void
}

/** CDP 命令走扩展的 chrome.debugger（per-tab attach，产出 isTrusted 原生事件）。 */
export class BridgeCdpSession implements CdpSessionLike {
  constructor(
    private readonly bridge: BridgeLike,
    private readonly tabId: number,
  ) {}

  /**
   * 协议链路：{cmd:'cdp'} → 扩展 chrome.debugger.sendCommand → 原始 CDP 结果
   * 回传（background 已展平，sendCommand 拿到的就是 CDP 返回值）。
   */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.bridge.sendCommand({ cmd: 'cdp', tabId: this.tabId, method, params: params ?? {} })
  }
}

/** 真实 Chrome 的一个标签页 → CaptchaPage。 */
export class BridgeCaptchaPage implements CaptchaPage {
  constructor(
    private readonly bridge: BridgeLike,
    public readonly tab: BridgeTab,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {}

  url(): string { return this.tab.url }

  async evalJson<T>(expr: string): Promise<T> {
    const res = await this.bridge.executeJs(this.tab.id, expr)
    return res.data as T
  }

  async screenshot(): Promise<Uint8Array> {
    const cdp = this.cdp()
    if (!cdp) throw new Error('桥已断开，截不了图')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string }
    return Buffer.from(shot.data, 'base64')
  }

  cdp(): CdpSessionLike | null {
    return this.bridge.isConnected() ? new BridgeCdpSession(this.bridge, this.tab.id) : null
  }

  async viewport(): Promise<{ width: number; height: number } | null> {
    try {
      return await this.evalJson<{ width: number; height: number } | null>(
        'return { width: window.innerWidth, height: window.innerHeight }',
      )
    } catch { return null }
  }

  async waitForTimeout(ms: number): Promise<void> { await this.sleep(ms) }
}

/**
 * 为目标站点找一个可用的桥标签页：已有该站点的 tab 直接复用（登录态就在里面）；
 * 没有就开一个（后台打开，不抢用户当前 tab）。
 */
export async function bridgePageFor(
  bridge: BridgeLike | ExtensionBridge,
  urlPattern: string,
  openUrl?: string,
): Promise<BridgeCaptchaPage | null> {
  if (!bridge.isConnected()) return null
  let tab = bridge.findTab(urlPattern)
  if (!tab && openUrl) {
    const created = await bridge.sendCommand<{ id?: number; url?: string; title?: string }>(
      { cmd: 'tabs', method: 'create', url: openUrl, active: false },
    )
    if (!created?.id) return null
    tab = { id: created.id, url: created.url ?? openUrl, title: created.title ?? '' }
  }
  if (!tab) return null
  return new BridgeCaptchaPage(bridge as BridgeLike, tab)
}

export interface ScreencastFrame {
  /** JPEG/PNG 帧数据（base64）。 */
  data: string
  format?: string
  /** 帧元数据（offsetWidth/Height、pageScaleFactor…），现场画面比例用。 */
  metadata?: unknown
}

export interface BridgeScreencast {
  stop(): Promise<void>
}

/**
 * 用户真实浏览器标签页的 screencast（产品内"现场画面"的桥数据源）：
 * 持久 attach（cdp_attach）→ Page.startScreencast → 帧经 cdp_event 上行 →
 * 每帧 ACK（不 ACK Chrome 不发下一帧）→ stop 时停流并 detach（黄条消失）。
 * 注意：持久 attach 期间 Chrome 顶部有"正在调试此浏览器"黄条（无法隐藏），
 * 所以按需开、用完就关。
 */
export async function startTabScreencast(
  bridge: BridgeLike & Partial<BridgeEventSource>,
  tabId: number,
  onFrame: (frame: ScreencastFrame) => void,
  opts: { onDetached?: (reason: string) => void } = {},
): Promise<BridgeScreencast> {
  if (!bridge.onCdpEvent) throw new Error('这个桥没有事件上行能力')
  let stopped = false
  const offEvent = bridge.onCdpEvent(event => {
    if (event.tabId !== tabId) return
    if (event.kind === 'detached') {
      stopped = true
      opts.onDetached?.(event.reason ?? '')
      return
    }
    if (event.method === 'Page.screencastFrame') {
      const p = (event.params ?? {}) as { data?: string; format?: string; metadata?: unknown; sessionId?: string }
      if (!p.data) return
      onFrame({ data: p.data, format: p.format, metadata: p.metadata })
      // ACK 下一帧（Chrome 要求逐帧确认）
      void bridge.sendCommand({ cmd: 'cdp', tabId, method: 'Page.screencastFrameAck', params: { sessionId: p.sessionId } }).catch(() => {})
    }
  })
  const offDisconnect = bridge.onDisconnect?.(() => { stopped = true; opts.onDetached?.('bridge-disconnected') })
  await bridge.sendCommand({ cmd: 'cdp_attach', tabId })
  await bridge.sendCommand({ cmd: 'cdp', tabId, method: 'Page.startScreencast', params: { format: 'jpeg', quality: 60, everyNthFrame: 1 } })
  return {
    async stop() {
      if (stopped) { offEvent(); offDisconnect?.(); return }
      stopped = true
      offEvent()
      offDisconnect?.()
      await bridge.sendCommand({ cmd: 'cdp', tabId, method: 'Page.stopScreencast', params: {} }).catch(() => {})
      await bridge.sendCommand({ cmd: 'cdp_detach', tabId }).catch(() => {})
    },
  }
}
