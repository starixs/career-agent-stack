import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { stageExtension, chromiumExtensionArgs } from '../stage-extension'
import { waitForBrowserResource, type BrowserResourceResolution } from '../resource-client'
import type { ExtensionBridge } from './extension-bridge'
import { cancellableDelay } from '../../utils/cancellation'

const RESOURCE_TIMEOUT_MS = 45 * 60_000 // Covers at most four 10-minute transports plus extraction.
/**
 * 等扩展连上来最多多久。要长过扩展的唤醒闹钟（chrome.alarms 最短 30 秒）：产品浏览器在 App 重启后还开着，
 * 新的启动请求交给了它，它的扩展后台已被 Chrome 挂起，只能等闹钟醒来再连（2026-11-04：等 20 秒必失败一次）。
 */
const CONNECT_TIMEOUT_MS = 45_000
const CLOSE_TIMEOUT_MS = 8_000
const START_ATTEMPTS = 3
const START_RETRY_MS = 1000 // Allow an exiting predecessor to release Chrome's profile lock.
export type ProductBrowserState = 'preparing' | 'starting' | 'ready' | 'failed' | 'closed'
type Bridge = Pick<ExtensionBridge, 'isConnected' | 'onTabsChange' | 'port'>
interface Process { exited: Promise<number | null>; stop(): Promise<void> }
interface Dependencies {
  dataDir: string
  resolve(signal: AbortSignal): Promise<BrowserResourceResolution>
  stage(dataDir: string, connection: { url: string; token: string }): string
  launch(executable: string, args: string[]): Process
}

export function productBrowserArgs(profile: string, extension: string): string[] {
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...chromiumExtensionArgs(extension), 'about:blank']
}

export function waitForConnection(bridge: Bridge, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (bridge.isConnected()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { off(); signal.removeEventListener('abort', aborted) }
    const aborted = () => { cleanup(); reject(new Error('BROWSER_CONNECT_CANCELLED')) }
    const off = bridge.onTabsChange(() => { if (bridge.isConnected()) { cleanup(); resolve() } })
    signal.addEventListener('abort', aborted, { once: true })
    if (bridge.isConnected()) { cleanup(); resolve() }
    else if (signal.aborted) aborted()
  })
}

function launch(executable: string, args: string[]): Process {
  // No remote-debugging/headless/enable-automation flags. Only our own profile.
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error('BROWSER_PROCESS_START_FAILED')))
    child.once('exit', code => resolve(code))
  })
  return { exited, async stop() {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS) })])
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    } finally { clearTimeout(timer) }
  } }
}

const defaults: Dependencies = { dataDir: join(homedir(), '.keystone'), resolve: waitForBrowserResource, stage: stageExtension, launch }

export class ProductBrowser {
  state: ProductBrowserState = 'preparing'
  private process: Process | null = null
  private starting: Promise<void> | null = null
  private readonly lifetime = new AbortController()

  private readonly deps: Dependencies
  constructor(private readonly bridge: Bridge, private readonly token: string, deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps }
  }

  start(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('BROWSER_STOPPING'))
    if (this.state === 'ready' && this.bridge.isConnected()) return Promise.resolve()
    const work = () => this.process ? this.reconnect() : this.prepareWithRetry()
    this.starting ??= work().catch(async error => {
      if (this.lifetime.signal.aborted) { this.state = 'closed'; throw new Error('BROWSER_STOPPING') }
      const phase = this.state; this.state = 'failed'
      const code = error instanceof Error && /^BROWSER_[A-Z_]+(?::[-\d]+|:null)?$/.test(error.message) ? error.message : 'BROWSER_PREPARATION_FAILED'
      console.warn(`[product-browser] failed phase=${phase} code=${code}; no user Chrome changes`)
      await this.process?.stop(); this.process = null
      throw new Error('BROWSER_PREPARATION_FAILED')
    }).finally(() => { this.starting = null })
    return this.starting
  }

  private async prepareWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await this.prepare(); return }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('BROWSER_EXITED:') || attempt >= START_ATTEMPTS) throw error
        console.warn(`[product-browser] early exit; retry=${attempt}`)
        await cancellableDelay(START_RETRY_MS, this.lifetime.signal)
      }
    }
  }

  private async prepare(): Promise<void> {
    this.state = 'preparing'
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(RESOURCE_TIMEOUT_MS)])
    const resource = await this.deps.resolve(signal)
    signal.throwIfAborted()
    const extension = this.deps.stage(this.deps.dataDir, { url: `ws://127.0.0.1:${this.bridge.port}`, token: this.token })
    const profile = join(this.deps.dataDir, 'browser-profile', 'product')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    this.state = 'starting'
    const process = this.deps.launch(resource.executablePath, productBrowserArgs(profile, extension))
    this.process = process
    const exit = process.exited.then(code => {
      if (this.process === process) { this.process = null; this.state = 'closed' }
      throw new Error(`BROWSER_EXITED:${code}`)
    })
    const handshake = new AbortController()
    const connected = waitForConnection(this.bridge, AbortSignal.any([signal, handshake.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]))
    try { await Promise.race([connected, exit]) } finally { handshake.abort() }
    this.state = 'ready'
    console.log('[product-browser] ready: extension connected, persistent product profile')
  }

  private async reconnect(): Promise<void> {
    this.state = 'starting'
    await waitForConnection(this.bridge, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]))
    this.state = 'ready'
  }

  async stop(): Promise<void> {
    this.lifetime.abort()
    const process = this.process; this.process = null
    await process?.stop()
    this.state = 'closed'
  }
}
