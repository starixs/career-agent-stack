import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MiniWsConnection, startMiniWsServer, type MiniWsServer } from './ws-mini.js'

/**
 * 扩展桥服务端：TMWebDriver（lsdefine/GenericAgent，MIT）语义的 Node 移植。
 *
 * 架构：产品自动预置 Chrome 扩展（extension/），background service worker
 * 主动连出到本服务（ws://127.0.0.1:18775），先通过安装级密钥握手。
 * 使用产品专用持久 profile，不修改日常 Chrome；无 CDP-at-launch 或
 * --enable-automation。需要输入/截图时由扩展借用 debugger，不保证绕过风控。
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

/** 扩展上行的 CDP 事件（screencast 帧等）。 */
export interface BridgeCdpEvent {
  kind: 'event' | 'detached'
  tabId: number
  method?: string
  params?: unknown
  /** detached 时的原因（用户点了黄条"取消" / 标签页关闭）。 */
  reason?: string
}

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
const tabSchema = z.object({ id: z.number().int(), url: z.string(), title: z.string().default('') })
const messageSchema = z.object({
  type: z.enum(['ext_ready', 'tabs_update', 'cdp_event', 'cdp_detached', 'ack', 'result', 'error', 'ping']),
  token: z.string().optional(), tabs: z.array(tabSchema).optional(), newTabs: z.array(tabSchema).optional(),
  id: z.string().optional(), tabId: z.number().int().optional(), method: z.string().optional(),
  params: z.unknown().optional(), reason: z.string().optional(), result: z.unknown().optional(), error: z.unknown().optional(),
})

export class ExtensionBridge {
  private server: MiniWsServer | null = null
  private conn: MiniWsConnection | null = null
  private readonly tabsById = new Map<number, BridgeTab>()
  private readonly pending = new Map<string, PendingExec>()
  private readonly tabListeners = new Set<(tabs: BridgeTab[]) => void>()
  private readonly cdpListeners = new Set<(event: BridgeCdpEvent) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private connectivityTimer: NodeJS.Timeout | null = null

  private constructor(private readonly log: (msg: string, err?: unknown) => void, private readonly token?: string) {}
  get port(): number { return this.server?.port ?? EXTENSION_BRIDGE_DEFAULT_PORT }

  static async start(opts: { port?: number; token?: string; log?: (msg: string, err?: unknown) => void } = {}): Promise<ExtensionBridge> {
    const bridge = new ExtensionBridge(opts.log ?? (() => {}), opts.token)
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
    let decoded: unknown
    try { decoded = JSON.parse(raw) } catch { this.log('[extension-bridge] malformed message'); conn.close(); return }
    const parsed = messageSchema.safeParse(decoded)
    if (!parsed.success) { this.log('[extension-bridge] invalid message'); conn.close(); return }
    const msg = parsed.data
    if (conn !== this.conn) {
      if (msg.type !== 'ext_ready' || (this.token !== undefined && msg.token !== this.token)) {
        this.log('[extension-bridge] unauthorized connection rejected'); conn.close(); return
      }
      this.conn?.close()
      this.conn = conn
      this.log('[extension-bridge] extension connected')
    }
    const type = msg.type
    if (type === 'ext_ready' || type === 'tabs_update') {
      this.syncTabs(msg.tabs)
      return
    }
    // CDP 事件上行（持久 attach 的标签页）：screencast 帧流 / 会话被用户断开
    if (type === 'cdp_event' || type === 'cdp_detached') {
      const tabId = Number(msg.tabId)
      if (Number.isInteger(tabId)) {
        const event: BridgeCdpEvent = type === 'cdp_event'
          ? { kind: 'event', tabId, method: String(msg.method ?? ''), params: msg.params }
          : { kind: 'detached', tabId, reason: typeof msg.reason === 'string' ? msg.reason : '' }
        for (const cb of this.cdpListeners) { try { cb(event) } catch { /* listener 自己崩不影响桥 */ } }
      }
      return
    }
    const id = msg.id
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
      // 扩展一断，持久 attach（screencast 会话）全部失效
      for (const cb of this.disconnectListeners) { try { cb() } catch { /* listener 自己崩不影响桥 */ } }
      // 导航 / 扩展重载期间在途请求：给个短暂窗口等重连，到点报错
      for (const [, p] of this.pending) {
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

  /** 订阅上行 CDP 事件（screencast 帧等）。 */
  onCdpEvent(cb: (event: BridgeCdpEvent) => void): () => void {
    this.cdpListeners.add(cb)
    return () => this.cdpListeners.delete(cb)
  }

  /** 订阅扩展断开（持久 attach 的会话随之全部失效）。 */
  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb)
    return () => this.disconnectListeners.delete(cb)
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
      return Promise.reject(new Error('扩展未连接：产品浏览器尚未自动就绪，请稍后重试'))
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
