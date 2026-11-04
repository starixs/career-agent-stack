import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductBrowser, productBrowserArgs, waitForConnection } from './product-browser'
import { extensionSourceDir, stageExtension } from '../stage-extension'
import type { BridgeTab } from './extension-bridge'
import { productConnectionToken } from './connection-token'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'product-browser-test-')); roots.push(root)
  let connected = false
  const listeners = new Set<(tabs: BridgeTab[]) => void>()
  const bridge = { port: 18775, isConnected: () => connected, onTabsChange: (fn: (tabs: BridgeTab[]) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const stop = vi.fn(async () => {})
  const launch = vi.fn(() => ({ exited: new Promise<number | null>(() => {}), stop }))
  const deps = { dataDir: root, resolve: vi.fn(async (_signal: AbortSignal) => ({ executablePath: '/official/browser', revision: 'pinned' })), stage: vi.fn(() => join(root, 'extension')), launch }
  const browser = new ProductBrowser(bridge, 'x'.repeat(64), deps)
  return { root, bridge, listeners, browser, deps, stop, connect: () => { connected = true; for (const fn of listeners) fn([]) }, disconnect: () => { connected = false } }
}

describe('product-owned browser bootstrap', () => {
  it('prepares once, launches without automation/CDP flags, and waits for real extension handshake', async () => {
    const f = await fixture()
    const first = f.browser.start(), second = f.browser.start()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(f.deps.launch).toHaveBeenCalledOnce())
    expect(f.browser.state).toBe('starting')
    f.connect(); await first
    expect(f.browser.state).toBe('ready')
    expect(f.deps.stage).toHaveBeenCalledWith(f.root, { url: 'ws://127.0.0.1:18775', token: 'x'.repeat(64) })
    expect(f.deps.launch.mock.calls[0]).toEqual(['/official/browser', productBrowserArgs(join(f.root, 'browser-profile/product'), join(f.root, 'extension'))])
    expect(productBrowserArgs('/profile', '/bridge').join(' ')).not.toMatch(/headless|remote-debugging|enable-automation/)
    const marker = join(f.root, 'browser-profile/product/login-state')
    await writeFile(marker, 'retain')
    await f.browser.stop()
    expect(f.stop).toHaveBeenCalledOnce()
    expect(await readFile(marker, 'utf8')).toBe('retain')
  })

  it('reconnects an existing process without launching another profile', async () => {
    const f = await fixture(); const first = f.browser.start()
    await vi.waitFor(() => expect(f.deps.launch).toHaveBeenCalledOnce())
    f.connect(); await first; f.disconnect()
    const again = f.browser.start()
    f.connect(); await again
    expect(f.deps.launch).toHaveBeenCalledOnce()
    await f.browser.stop()
  })

  it('retries an early browser exit without deleting profile locks or user data', async () => {
    const f = await fixture()
    f.deps.launch.mockReturnValueOnce({ exited: Promise.resolve(21), stop: f.stop })
    const ready = f.browser.start()
    await vi.waitFor(() => expect(f.deps.launch).toHaveBeenCalledTimes(2), { timeout: 4000 })
    f.connect(); await ready
    expect(f.browser.state).toBe('ready')
    await f.browser.stop()
  })

  it('stopping while resources prepare prevents late browser launch', async () => {
    const f = await fixture()
    f.deps.resolve.mockImplementation(async signal => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { executablePath: '/late', revision: 'pinned' } })
    const ready = f.browser.start()
    const rejected = expect(ready).rejects.toThrow()
    await f.browser.stop(); await rejected
    expect(f.deps.launch).not.toHaveBeenCalled()
  })

  it('cancelling a handshake removes the listener', async () => {
    const f = await fixture(), abort = new AbortController()
    const ready = waitForConnection(f.bridge, abort.signal)
    abort.abort()
    await expect(ready).rejects.toThrow('BROWSER_CONNECT_CANCELLED')
    expect(f.listeners.size).toBe(0)
  })

  it('stages private connection data without modifying shipped extension source', async () => {
    const f = await fixture()
    const source = join(extensionSourceDir(), 'connection.js')
    const before = await readFile(source, 'utf8')
    const target = stageExtension(f.root, { url: 'ws://127.0.0.1:12345', token: 'x'.repeat(64) })
    expect(await readFile(join(target, 'connection.js'), 'utf8')).toContain('12345')
    expect(await readFile(source, 'utf8')).toBe(before)
    expect(stageExtension(f.root, { url: 'ws://127.0.0.1:12345', token: 'x'.repeat(64) })).toBe(target)
    expect(stageExtension(f.root, { url: 'ws://127.0.0.1:12345', token: 'y'.repeat(64) })).not.toBe(target)
    expect(productConnectionToken(f.root)).toBe(productConnectionToken(f.root))
  })
})
