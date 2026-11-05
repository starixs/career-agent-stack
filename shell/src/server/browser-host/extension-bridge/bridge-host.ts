import { homedir } from 'node:os'
import { join } from 'node:path'
import { productConnectionToken } from './connection-token'
import { ExtensionBridge, EXTENSION_BRIDGE_DEFAULT_PORT } from './extension-bridge'
import { ProductBrowser } from './product-browser'
import { raceWithAbortSignal } from '../../utils/cancellation'
import { BridgePageProxySet } from './bridge-page-proxy'

/**
 * 扩展桥进程内单例：sidecar 启动时拉起（CAREER_BROWSER_EXTENSION_BRIDGE=0 关闭），
 * 供路由 / 批量运行器复用。产品浏览器（预置扩展，无手工安装步骤）在第一次真正要用时才拉起
 * （ensureProductBrowserReady：投递、填表、登录、打开网页都经过它），开机不再先起一整个 Chrome（11-05 你定）。
 * browse / apply 仍只通过 BridgePageProxy 执行；没有第二套 Playwright 驱动。
 */

let instance: ExtensionBridge | null = null
let starting: Promise<ExtensionBridge | null> | null = null
let proxySet: BridgePageProxySet | null = null
let productBrowser: ProductBrowser | null = null
let shuttingDown = false
export function extensionBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAREER_BROWSER_EXTENSION_BRIDGE !== '0' && (!env.KEYSTONE_SIDECAR_ID || env.KEYSTONE_SIDECAR_ID === '__global__')
}

export async function ensureExtensionBridge(): Promise<ExtensionBridge | null> {
  if (shuttingDown || !extensionBridgeEnabled()) return null
  if (instance) return instance
  const managed = process.env.KEYSTONE_SIDECAR_ID === '__global__'
  const token = managed ? productConnectionToken(join(homedir(), '.keystone')) : undefined
  starting ??= ExtensionBridge.start({
    token,
    port: Number(process.env.CAREER_BROWSER_EXTENSION_BRIDGE_PORT) || EXTENSION_BRIDGE_DEFAULT_PORT,
    log: (msg, err) => console.log(msg, err ?? ''),
  }).then(async bridge => {
    if (shuttingDown) { await bridge.stop(); return null }
    instance = bridge
    // 只建好对象，不启动：第一次 ensureProductBrowserReady() 时再拉起 Chrome。
    if (token) productBrowser = new ProductBrowser(bridge, token)
    return bridge
  }).catch(error => {
    console.warn(`[extension-bridge] start-failed error=${error instanceof Error ? error.message : String(error)}`)
    return null
  }).finally(() => { starting = null })
  return starting
}

/** 有没有人要过浏览器：没要过时实时画面的提示是「用到时会自动打开」，而不是「正在准备」。 */
let productBrowserRequested = false

export async function ensureProductBrowserReady(signal?: AbortSignal): Promise<void> {
  if (!productBrowser) throw new Error('BROWSER_PREPARATION_UNAVAILABLE')
  if (!productBrowserRequested) console.log('[product-browser] first use — launching on demand')
  productBrowserRequested = true
  const ready = productBrowser.start()
  await (signal ? raceWithAbortSignal(ready, signal) : ready)
}

export function productBrowserWaitingMessage(): string {
  if (productBrowser && !productBrowserRequested) return '开始填表或打开网页时，浏览器会自动打开'
  if (productBrowser?.state === 'failed') return '浏览器自动准备失败，请检查网络或磁盘空间后重启应用；无需手动安装扩展'
  if (productBrowser?.state === 'closed') return '浏览器已关闭；下次执行任务时会自动打开'
  if (productBrowser?.state === 'starting' || productBrowser?.state === 'ready') return '正在自动连接浏览器，连通后画面会自动出现'
  return '正在自动准备浏览器，首次可能需要下载；无需安装扩展或配置端口'
}

export async function stopExtensionBridge(): Promise<void> {
  shuttingDown = true
  await starting
  try { await productBrowser?.stop() }
  finally {
    await instance?.stop()
    proxySet?.dispose(); proxySet = null
    productBrowser = null; instance = null; productBrowserRequested = false
  }
}

/** 已启动的桥（没启动返回 null——不拉起，纯查询用）。 */
export function extensionBridge(): ExtensionBridge | null {
  return instance
}

/**
 * 桥已连接时返回"真实浏览器 context"（BridgePageProxySet 扮演 playwright
 * BrowserContext 的引擎面）。没连返回 null。
 * 只查已启动的桥（sidecar 启动时拉起）；**不在这里起服务**——路由热路径和
 * 单测都可能走到，bind 端口是集成环境的事。
 */
export function bridgeEngineContext(): { context: unknown; set: BridgePageProxySet } | null {
  const bridge = instance
  if (!bridge || !bridge.isConnected()) return null
  proxySet ??= new BridgePageProxySet({ bridge, tabs: bridge })
  return { context: proxySet.toContext(), set: proxySet }
}
