import { randomUUID } from 'node:crypto'
import { MiniWsConnection, startMiniWsServer, type MiniWsServer } from './ws-mini.js'

/**
 * 扩展桥服务端：TMWebDriver（lsdefine/GenericAgent，MIT）语义的 Node 移植。
 *
 * 架构：Chrome 扩展（extension/ 目录）装在用户的真实 Chrome 里，background
 * service worker **主动连出**到本服务（ws://127.0.0.1:18775）。页面零痕迹：
 * 没有 CDP-at-launch、没有 --enable-automation、navigator.webdriver 在
 * document_start 就被删掉。登录态 / Cookie / 指纹全部是用户真实浏览器的。
 *
 * 协议（extension → server）：
 *   {type:'ext_ready', tabs}  连接建立 + 全量标签
 *   {type:'tabs_update', tabs} 标签增删改
 *   {type:'ack', id}           脚本已送达
 *   {type:'result', id, result, newTabs} / {type:'error', id, error, newTabs}
 * 协议（server → extension）：
 *   {id, tabId, code}                    在标签页主世界执行 JS
 *   {id, tabId?, cmd:'tabs'|'cookies'|'cdp'|'batch', ...}   扩展能力命令
 */

export const EXTENSION_BRIDGE_DEFAULT_PORT = 18775

export interface BridgeTab { id: number; url: string; title: string }

export interface ExecuteJsResult {
  data: unknown
  /** 执行期间新开的标签（点击 target=_blank 等）。 */
  newTabs?: BridgeTab[]
}

interface PendingExec {
  resolve: (r: ExecuteJsResult) => void
  reject: (e: Error) => void
  acked: boolean
  timer: NodeJS.Timeout
}

const CONNECTIVITY_CHECK_MS = 3_000

export class ExtensionBridge {
  private server: MiniWsServer | null = null
  private conn: MiniWsConnection | null = null
  private readonly tabsById = new Map<number, BridgeTab>()
  private readonly pending = new Map<string, PendingExec>()
  private readonly tabListeners = new Set<(tabs: BridgeTab[]) => void>()
  private connectivityTimer: NodeJS.Timeout | null = null

  private constructor(private readonly log: (msg: string, err?: unknown) => void) {}

  static async start(opts: { port?: number; log?: (msg: string, err?: unknown) => void } = {}): Promise<ExtensionBridge> {
    const bridge = new ExtensionBridge(opts.log ?? (() => {}))
    bridge.server = await startMiniWsServer('127.0.0.1', opts.port ?? EXTENSION_BRIDGE_DEFAULT_PORT, conn => ({
      onMessage: raw => bridge.handleMessage(conn, raw),
      onClose: () => bridge.handleClose(conn),
    }), bridge.log)
    // 扩展断开后周期性广播状态（UI 显示"扩展未连接"）
    bridge.connectivityTimer = setInterval(() => bridge.emitTabs(), CONNECTIVITY_CHECK_MS)
    bridge.log(`[extension-bridge] listening on 127.0.0.1:${bridge.server.port}`)
    return bridge
  }

  private handleMessage(conn: MiniWsConnection, raw: string): void {
    if (conn !== this.conn && this.conn?.isConnected()) {
      // 同时装了两份扩展 / 两个浏览器：只认最新的
      this.log('[extension-bridge] second connection; keeping latest')
    }
    this.conn = conn
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }
    const type = msg.type as string | undefined
    if (type === 'ext_ready' || type === 'tabs_update') {
      this.syncTabs(msg.tabs as BridgeTab[] | undefined)
      return
    }
    const id = msg.id as string | undefined
    if (!id) return
    const pending = this.pending.get(id)
    if (type === 'ack' && pending) { pending.acked = true; return }
    if ((type === 'result' || type === 'error') && pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      const newTabs = normalizeTabs(msg.newTabs)
      if (type === 'result') pending.resolve({ data: msg.result, newTabs: newTabs.length ? newTabs : undefined })
      else pending.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
    }
  }

  private handleClose(conn: MiniWsConnection): void {
    if (this.conn === conn) {
      this.conn = null
      this.log('[extension-bridge] extension disconnected')
      // 导航 / 扩展重载期间在途请求：给个短暂窗口等重连，到点报错
      for (const [id, p] of this.pending) {
        p.timer.refresh?.()
      }
      this.emitTabs()
    }
  }

  private syncTabs(tabs: BridgeTab[] | undefined): void {
    if (!Array.isArray(tabs)) return
    this.tabsById.clear()
    for (const t of normalizeTabs(tabs)) this.tabsById.set(t.id, t)
    this.emitTabs()
  }

  private emitTabs(): void {
    const snapshot = this.tabs()
    for (const cb of this.tabListeners) { try { cb(snapshot) } catch { /* listener 自己崩不影响桥 */ } }
  }

  onTabsChange(cb: (tabs: BridgeTab[]) => void): () => void {
    this.tabListeners.add(cb)
    return () => this.tabListeners.delete(cb)
  }

  tabs(): BridgeTab[] { return [...this.tabsById.values()] }

  isConnected(): boolean { return this.conn?.isConnected() ?? false }

  findTab(urlPattern: string): BridgeTab | null {
    const matches = this.tabs().filter(t => t.url.includes(urlPattern))
    return matches[0] ?? null
  }

  /** 在扩展所在的浏览器里执行 JS（标签页主世界）。 */
  async executeJs(tabId: number, code: string, timeoutMs = 15_000): Promise<ExecuteJsResult> {
    return this.request({ id: randomUUID(), tabId, code }, timeoutMs)
  }

  /** 扩展能力命令：{cmd:'tabs'|'cookies'|'cdp'|'batch', ...}。 */
  async sendCommand<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const res = await this.request({ id: randomUUID(), ...cmd }, timeoutMs)
    return res.data as T
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<ExecuteJsResult> {
    const conn = this.conn
    if (!conn?.isConnected()) {
      return Promise.reject(new Error('扩展未连接：请在浏览器里安装并启用 career-bridge 扩展（extension-bridge/extension，未打包加载）'))
    }
    const id = payload.id as string
    return new Promise<ExecuteJsResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`扩展请求超时（${timeoutMs}ms, ack 后无结果：脚本可能仍在跑）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, acked: false, timer })
      conn.sendText(JSON.stringify(payload))
    })
  }

  async stop(): Promise<void> {
    if (this.connectivityTimer) { clearInterval(this.connectivityTimer); this.connectivityTimer = null }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('bridge stopped')) }
    this.pending.clear()
    this.conn?.close()
    await this.server?.close()
    this.server = null
  }
}

function normalizeTabs(tabs: unknown): BridgeTab[] {
  if (!Array.isArray(tabs)) return []
  const out: BridgeTab[] = []
  for (const t of tabs) {
    if (!t || typeof (t as BridgeTab).id !== 'number' || typeof (t as BridgeTab).url !== 'string') continue
    out.push({ id: (t as BridgeTab).id, url: (t as BridgeTab).url, title: String((t as BridgeTab).title ?? '') })
  }
  return out
}
