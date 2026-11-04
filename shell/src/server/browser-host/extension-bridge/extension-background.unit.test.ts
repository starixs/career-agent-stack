import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute the shipped service worker against Chrome API doubles, not a second
// implementation of its tab filtering / debugger cleanup policies.
function worker() {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  class Socket {
    static OPEN = 1
    readyState = 1
    onclose?: () => Promise<void>
    send = vi.fn()
  }
  const debuggerApi = { onEvent: event(), onDetach: event(), attach: vi.fn(async () => {}), detach: vi.fn(async (_target: { tabId: number }) => {}), sendCommand: vi.fn(async () => ({})) }
  const context = createContext({
    WebSocket: Socket, console, setTimeout: vi.fn(), clearTimeout: vi.fn(),
    importScripts: vi.fn(), CAREER_BRIDGE_CONFIG: { url: 'ws://127.0.0.1:18775', token: 'fixture-token' },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      tabs: {
        onUpdated: event(), onRemoved: event(), onCreated: event(),
        query: async () => [
          { id: 1, url: 'about:blank', title: '' },
          { id: 2, url: 'https://example.test', title: 'Site' },
          { id: 3, url: 'chrome://extensions', title: 'Extensions' },
        ],
        sendMessage: async () => {},
      },
      debugger: debuggerApi,
      alarms: { onAlarm: event(), create: vi.fn() },
      runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    },
  })
  runInContext(readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8'), context)
  return { context, debuggerApi }
}

describe('shipped career-bridge service worker', () => {
  it('sends the product-provided token on automatic connection', async () => {
    const { context } = worker()
    await runInContext('ws.onopen()', context)
    expect(runInContext('JSON.parse(ws.send.mock.calls[0][0]).token', context)).toBe('fixture-token')
  })

  it('retains a newly created blank tab until navigation, excludes Chrome internal pages', async () => {
    const { context } = worker()
    const tabs = await runInContext('currentTabs()', context)
    expect(tabs.map((t: { id: number }) => t.id)).toEqual([1, 2])
  })

  it('disconnect drains every debugger attachment before permitting reconnect', async () => {
    const { context, debuggerApi } = worker()
    await runInContext('handleCdpAttach({tabId: 1})', context)
    await runInContext('handleCdpAttach({tabId: 2})', context)
    const close = runInContext('ws.onclose()', context)
    expect(runInContext('disconnecting', context)).toBe(true)
    runInContext('connectWS()', context)
    expect(runInContext('ws', context)).toBeNull()
    await close
    expect(debuggerApi.detach.mock.calls.map(c => c[0])).toEqual([{ tabId: 1 }, { tabId: 2 }])
    expect(runInContext('attachedTabs.size', context)).toBe(0)
    runInContext('connectWS()', context)
    expect(runInContext('ws !== null', context)).toBe(true)
  })
})

describe('debugger attachment recovery', () => {
  it('标记仍在但 Chrome 已 detach 时，重挂一次再发，不重复脱离持久会话', async () => {
    const { context, debuggerApi } = worker()
    await runInContext('handleCdpAttach({tabId: 1})', context)
    debuggerApi.sendCommand.mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 1.'))
    const result = await runInContext('handleCdp({tabId:1,method:"Runtime.evaluate",params:{expression:"1"}})', context)
    expect(result).toEqual({ ok: true, data: {} })
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2)
    expect(debuggerApi.detach).not.toHaveBeenCalled()
  })
})
