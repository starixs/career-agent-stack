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
        get: async (id: number) => ({ id, url: 'about:blank', title: '' }),
      },
      debugger: debuggerApi,
      scripting: { executeScript: vi.fn(async () => { throw new Error('Cannot access contents of url "about:blank".') }) },
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

describe('exec CDP fallback', () => {
  it('现场画面已持久挂着这个标签页：兜底借它的调试器，不另挂也不卸，不报「已有调试器」、不拆现场画面（2026-11-04）', async () => {
    const { context, debuggerApi } = worker()
    await runInContext('handleCdpAttach({tabId: 1})', context)
    debuggerApi.attach.mockClear()
    debuggerApi.sendCommand.mockResolvedValueOnce({ result: { value: { ok: true, data: 42 } } } as never)
    const sent: string[] = []
    // 代码里等 200ms 看有没有新开标签：替身的 setTimeout 立刻回调
    Object.assign(context, { sent, setTimeout: (fn: () => void) => { fn(); return 0 } })
    runInContext('ws = { readyState: 1, send: s => sent.push(s) }', context)
    await runInContext('handleWsExec({ id: "e1", tabId: 1, code: "42" })', context)
    expect(debuggerApi.attach).not.toHaveBeenCalled()
    expect(debuggerApi.detach).not.toHaveBeenCalled()
    expect(sent.map(s => JSON.parse(s).type)).toContain('result')
  })
})

describe('navigateTab', () => {
  it('到点还没 complete、但标签页已经在目标站：算导航成功（页面一直有资源在加载，2026-11-04 中国中车）', async () => {
    const { context } = worker()
    let fire: (() => void) | undefined
    Object.assign(context, { URL, setTimeout: (fn: () => void) => { fire = fn; return 0 } })
    const chrome = (context as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome
    chrome.tabs.update = async () => ({ id: 7, url: 'https://crrc.hotjob.cn/a', status: 'loading' })
    chrome.tabs.get = async () => ({ id: 7, url: 'https://crrc.hotjob.cn/a', status: 'loading', title: '中国中车' })
    const pending = runInContext('navigateTab(7, "https://crrc.hotjob.cn/a")', context) as Promise<{ ok: boolean }>
    await Promise.resolve(); fire?.()
    expect(await pending).toMatchObject({ ok: true })
  })

  it('到点还停在空白页：照样报超时', async () => {
    const { context } = worker()
    let fire: (() => void) | undefined
    Object.assign(context, { URL, setTimeout: (fn: () => void) => { fire = fn; return 0 } })
    const chrome = (context as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome
    chrome.tabs.update = async () => ({ id: 7, url: 'about:blank', status: 'loading' })
    chrome.tabs.get = async () => ({ id: 7, url: 'about:blank', status: 'loading' })
    const pending = runInContext('navigateTab(7, "https://crrc.hotjob.cn/a")', context) as Promise<unknown>
    await Promise.resolve(); fire?.()
    await expect(pending).rejects.toThrow('Navigation timed out')
  })
})
