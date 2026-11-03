import { cpSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 扩展预置：把 career-bridge 扩展复制到数据目录（防止用户直接改仓库里的源文件），
 * 并给出托管 Chromium 的 `--load-extension` 启动参数。
 *
 * 能力边界（重要）：
 * - Chrome 136+ 品牌版禁用了 `--load-extension`，本机 Chrome 只能手动
 *   chrome://extensions 未打包加载（见 extension/README.md）。
 * - 托管 Chromium（CAREER_BROWSER_CHANNEL=chromium）仍支持启动参数加载。
 */

export const EXTENSION_DIR_NAME = 'career-bridge'

/** 源目录（仓库内 extension/，bundle 后相对本文件）。 */
export function extensionSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'extension-bridge', 'extension')
}

/** 把扩展复制到 dataDir 下（幂等：已存在先覆盖关键文件）。 */
export function stageExtension(dataDir: string): string {
  const target = join(dataDir, 'browser-extension', EXTENSION_DIR_NAME)
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  cpSync(extensionSourceDir(), target, { recursive: true })
  return target
}

/** 托管 Chromium 加载扩展的启动参数。 */
export function chromiumExtensionArgs(extensionDir: string): string[] {
  return [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
}

/** 扩展加载是否开启：默认关（本机 Chrome 装不上，白给参数；Chromium 显式开）。 */
export function extensionLoadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAREER_BROWSER_EXTENSION === '1'
}
