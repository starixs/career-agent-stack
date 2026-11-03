import { ExtensionBridge, EXTENSION_BRIDGE_DEFAULT_PORT } from './extension-bridge'

/**
 * 扩展桥进程内单例：sidecar 启动时拉起（CAREER_BROWSER_EXTENSION_BRIDGE=0 关闭），
 * 供路由 / 批量运行器复用。用户日常 Chrome 装 career-bridge 扩展后连入。
 */

let instance: ExtensionBridge | null = null
let starting: Promise<ExtensionBridge> | null = null

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
    return null as unknown as ExtensionBridge
  })
  return starting
}

/** 已启动的桥（没启动返回 null——不拉起，纯查询用）。 */
export function extensionBridge(): ExtensionBridge | null {
  return instance
}
