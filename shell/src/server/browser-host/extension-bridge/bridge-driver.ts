import type { CaptchaPage, CdpSessionLike } from '@career/captcha'
import type { BridgeTab, ExtensionBridge } from './extension-bridge'

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
