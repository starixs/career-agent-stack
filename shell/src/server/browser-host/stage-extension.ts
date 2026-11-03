import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 产品自动预置 career-bridge 到自己的数据目录；仅给产品准备的官方浏览器加载。
 * 不修改用户日常 Chrome 的 Preferences / policy，也不要求开启开发者模式。
 */

export const EXTENSION_DIR_NAME = 'career-bridge'

/** 源目录（仓库内 extension/，bundle 后相对本文件）。 */
export function extensionSourceDir(base = dirname(fileURLToPath(import.meta.url))): string {
  const bundled = join(base, EXTENSION_DIR_NAME)
  const source = join(base, 'extension-bridge', 'extension')
  const selected = existsSync(join(bundled, 'manifest.json')) ? bundled : source
  const manifest = z.object({ manifest_version: z.literal(3), background: z.object({ service_worker: z.literal('background.js') }) })
  manifest.parse(JSON.parse(readFileSync(join(selected, 'manifest.json'), 'utf8')))
  return selected
}

/** 把扩展复制到 dataDir 下（幂等：已存在先覆盖关键文件）。 */
export function stageExtension(dataDir: string, connection?: { url: string; token: string }): string {
  const config = connection ? z.object({ url: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+$/), token: z.string().min(32) }).parse(connection) : undefined
  const source = extensionSourceDir()
  const digest = createHash('sha256').update(JSON.stringify(config ?? null))
  for (const name of readdirSync(source).filter(n => n.endsWith('.js') || n === 'manifest.json').sort()) {
    digest.update(name).update(readFileSync(join(source, name)))
  }
  // Immutable source/config path prevents Chrome reusing a cached MV3 worker
  // after an app upgrade. Unchanged builds keep the same extension identity.
  const target = join(dataDir, 'browser-extension', EXTENSION_DIR_NAME, digest.digest('hex').slice(0, 32))
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(target, 0o700)
  cpSync(source, target, { recursive: true })
  if (config) {
    const file = join(target, 'connection.js')
    writeFileSync(file, `globalThis.CAREER_BRIDGE_CONFIG = ${JSON.stringify(config)};\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  }
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
