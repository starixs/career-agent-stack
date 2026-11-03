import { ExtensionBridge, EXTENSION_BRIDGE_DEFAULT_PORT } from './extension-bridge'
import { BridgePageProxySet } from './bridge-page-proxy'

/**
 * 扩展桥进程内单例：sidecar 启动时拉起（CAREER_BROWSER_EXTENSION_BRIDGE=0 关闭），
 * 供路由 / 批量运行器复用。用户日常 Chrome 装 career-bridge 扩展后连入。
 * 单通道架构（ARCHITECTURE §4）：桥连接时 browse / apply 引擎全部跑在用户真实
 * 浏览器上（BridgePageProxy）；没有托管浏览器后备。
 */

let instance: ExtensionBridge | null = null
let starting: Promise<ExtensionBridge | null> | null = null
let proxySet: BridgePageProxySet | null = null
export function extensionBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAREER_BROWSER_EXTENSION_BRIDGE !== '0'
}

export async function ensureExtensionBridge(): Promise<ExtensionBridge | null> {
  if (!extensionBridgeEnabled()) return null
  if (instance) return instance
  starting ??= ExtensionBridge.start({
    port: Number(process.env.CAREER_BROWSER_EXTENSION_BRIDGE_PORT) || EXTENSION_BRIDGE_DEFAULT_PORT,
    log: (msg, err) => console.log(msg, err ?? ''),
  }).then(bridge => {
    instance = bridge
    return bridge
  }).catch(error => {
    console.warn(`[extension-bridge] start-failed error=${error instanceof Error ? error.message : String(error)}`)
    return null
  }).finally(() => { starting = null })
  return starting
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
