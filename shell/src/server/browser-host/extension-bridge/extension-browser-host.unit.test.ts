import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repos } from '@career/core'
import { BridgePageProxySet } from './bridge-page-proxy'
import { ExtensionBrowserHost } from './extension-browser-host'
import type { BridgeCdpEvent, BridgeTab } from './extension-bridge'
import { LiveHub } from '../../career/live-hub'
import { FileChooserBroker } from '../../career/file-chooser'
import { collectPassiveResponses } from '../../routes/career-browser'
import { handleCareerLiveRoute, type CareerLiveDeps } from '../../routes/career-live'

function harness() {
  let connected = true
  let tabs: BridgeTab[] = [{ id: 7, url: 'https://example.test/apply', title: 'Apply' }]
  const cdps = new Set<(e: BridgeCdpEvent) => void>()
  const tabListeners = new Set<(tabs: BridgeTab[]) => void>()
  const disconnects = new Set<() => void>()
  const calls: Record<string, unknown>[] = []
  const bridge = {
    isConnected: () => connected,
    tabs: () => tabs,
    findTab: () => tabs[0] ?? null,
    executeJs: vi.fn(async (_tabId: number, _code: string) => ({ data: { width: 1200, height: 800 } })),
    sendCommand: async <T,>(cmd: Record<string, unknown>): Promise<T> => {
      calls.push(cmd)
      if (cmd.method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } } as T
      if (cmd.method === 'Page.captureScreenshot') return { data: 'anBlZw==' } as T
      if (cmd.method === 'Network.getResponseBody') return { body: '{"jobs":[1]}', base64Encoded: false } as T
      if (cmd.method === 'DOM.resolveNode') return { object: { objectId: 'input-remote-object' } } as T
      if (cmd.method === 'Runtime.callFunctionOn') return { result: { value: '.pdf' } } as T
      return {} as T
    },
    onCdpEvent: (fn: (e: BridgeCdpEvent) => void) => { cdps.add(fn); return () => { cdps.delete(fn) } },
    onTabsChange: (fn: (t: BridgeTab[]) => void) => { tabListeners.add(fn); return () => { tabListeners.delete(fn) } },
    onDisconnect: (fn: () => void) => { disconnects.add(fn); return () => { disconnects.delete(fn) } },
  }
  const set = new BridgePageProxySet({ bridge, tabs: bridge, rand: () => 0.5, sleep: async () => {} })
  const context = set.toContext()
  const verifyCapability = vi.fn(async () => ({ productSessionId: 'career', workspacePath: '/isolated', hostGeneration: 1 }))
  const host = new ExtensionBrowserHost({ engine: () => connected ? { context, set } : null, verifyCapability })
  const hub = new LiveHub()
  const files = new FileChooserBroker(hub)
  host.setFileChooserListener((id, chooser) => { void files.offer(id, chooser) })
  const deps: CareerLiveDeps = { host, hub, files, productSessionId: () => 'career', repos: { openHandoffs: () => [] } as unknown as Repos, framesPollMs: 5 }
  const route = (action: string, body?: unknown, signal?: AbortSignal) => handleCareerLiveRoute(`/api/career/live/${action.split('?')[0]}`, new Request(`http://localhost/api/career/live/${action}`, {
    method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal,
  }), deps)
  return {
    host, set, context, calls, bridge, verifyCapability, hub, files, route, cdps,
    emit: (event: BridgeCdpEvent) => { for (const cb of cdps) cb(event) },
    disconnect: () => { connected = false; for (const cb of [...disconnects]) cb() },
    reconnect: () => { connected = true; for (const cb of tabListeners) cb(tabs) },
    tabs: (next: BridgeTab[]) => { tabs = next; for (const cb of tabListeners) cb(tabs) },
  }
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('condition did not become true')
}

function collect(response: Response) {
  let text = ''
  const reader = response.body!.getReader()
  const done = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; text += new TextDecoder().decode(r.value) } })()
  return { text: () => text, done, reader }
}

describe('extension browser host: one browser for engines and live UI', () => {
  it('hydrates existing tabs immediately; verifies capability; never starts a managed browser', async () => {
    const h = harness()
    expect(h.set.pages().map(p => p.tab.id)).toEqual([7])
    await h.host.withContext('token', async (context, binding) => {
      expect(context).toBe(h.context)
      expect(binding.productSessionId).toBe('career')
      await context.pages()[0].mouse.click(120, 80)
    })
    expect(h.verifyCapability).toHaveBeenCalledWith('token', undefined)
    expect(h.calls.filter(c => c.cmd === 'cdp_detach')).toHaveLength(1)
    h.disconnect()
    await expect(h.host.withContext('token', async () => {})).rejects.toMatchObject({ name: 'BRIDGE_NOT_CONNECTED' })
    await h.host.shutdown()
  })

  it('human control fences both chat and batch callers globally; read-only preview does not take control', async () => {
    const h = harness()
    await h.route('state')
    expect(h.host.getControl('career').control).toBe('agent')
    h.host.setControl('career', 'human')
    await expect(h.host.withContext('token', async () => {})).rejects.toMatchObject({ name: 'BROWSER_CONTROL_HUMAN' })
    await expect(h.host.withProductSession('other-session', async () => {})).rejects.toMatchObject({ name: 'BROWSER_CONTROL_HUMAN' })
    await expect(h.host.withProductSession('career', async () => 1, { allowHumanControl: true })).resolves.toBe(1)
    await h.host.shutdown()
  })

  it('emits renderer-compatible frames and ACKs, reconnects, and cancels without closing Chrome tabs', async () => {
    const h = harness()
    const abort = new AbortController()
    const response = await h.route('stream?frames=1', undefined, abort.signal)
    const stream = collect(response!)
    try {
      await until(() => h.calls.some(c => c.method === 'Page.startScreencast'))
      h.emit({ kind: 'event', tabId: 7, method: 'Page.screencastFrame', params: { data: 'ZnJhbWU=', sessionId: 9, metadata: { deviceWidth: 1200, deviceHeight: 800 } } })
      await until(() => stream.text().includes('ZnJhbWU='))
      expect(stream.text()).toContain('"width":1200,"height":800')
      expect(h.calls).toContainEqual(expect.objectContaining({ method: 'Page.screencastFrameAck', params: { sessionId: 9 } }))
      h.disconnect()
      await until(() => stream.text().includes('"state":"closed"'))
      expect(h.set.pages()).toHaveLength(0)
      h.reconnect()
      await until(() => h.calls.filter(c => c.method === 'Page.startScreencast').length === 2)
    } finally { abort.abort(); await stream.done; await until(() => h.calls.some(c => c.cmd === 'cdp_detach')); await h.host.shutdown() }
    expect(h.hub.size).toBe(0)
    expect(h.calls.some(c => c.cmd === 'tabs' && c.method === 'close')).toBe(false)
    expect(h.cdps.size).toBe(0)
  })

  it('maps frame coordinates to the actual viewport and preserves drag position/buttons, wheel and keys', async () => {
    const h = harness()
    expect((await h.route('input', { type: 'down' }))?.status).toBe(409)
    await h.route('control', { control: 'human' })
    const frame = { width: 600, height: 400 }
    for (const body of [
      { type: 'down', x: 100, y: 50, frame },
      { type: 'move', x: 120, y: 50, frame },
      { type: 'up', x: 120, y: 50, frame },
      { type: 'wheel', dx: 0, dy: 25, frame },
      { type: 'press', key: 'Control+a' },
    ]) expect((await h.route('input', body))?.status).toBe(200)
    const events = h.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params)
    expect(events).toContainEqual(expect.objectContaining({ type: 'mousePressed', x: 200, y: 100, buttons: 1 }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'mouseMoved', x: 240, y: 100, buttons: 1 }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'mouseReleased', x: 240, y: 100, buttons: 0 }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'mouseWheel', deltaY: 50 }))
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'Input.dispatchKeyEvent', params: expect.objectContaining({ key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 }) }))
    expect(h.calls.some(c => c.cmd === 'cdp_detach')).toBe(false)
    await h.route('control', { control: 'agent' })
    await until(() => h.calls.some(c => c.cmd === 'cdp_detach'))
    await h.host.shutdown()
  })

  it('shares the debugger between preview and input, and releases only the final lease', async () => {
    const h = harness()
    const page = h.set.pages()[0]
    const preview = await page.newCDPSession()
    await h.host.withProductSession('career', async context => { await context.pages()[0].mouse.click(10, 10) })
    expect(h.calls.filter(c => c.cmd === 'cdp_attach')).toHaveLength(1)
    expect(h.calls.filter(c => c.cmd === 'cdp_detach')).toHaveLength(0)
    await preview.detach()
    expect(h.calls.filter(c => c.cmd === 'cdp_detach')).toHaveLength(1)
    await h.host.shutdown()
  })

  it('shares screencast lifetime across two preview subscribers', async () => {
    const h = harness()
    const page = h.set.pages()[0]
    const a = await page.newCDPSession(), b = await page.newCDPSession()
    await Promise.all([a.send('Page.startScreencast'), b.send('Page.startScreencast')])
    expect(h.calls.filter(c => c.method === 'Page.startScreencast')).toHaveLength(1)
    await Promise.all([a.send('Page.screencastFrameAck', { sessionId: 10 }), b.send('Page.screencastFrameAck', { sessionId: 10 })])
    expect(h.calls.filter(c => c.method === 'Page.screencastFrameAck')).toHaveLength(1)
    await a.send('Page.stopScreencast'); await a.detach()
    expect(h.calls.some(c => c.method === 'Page.stopScreencast')).toBe(false)
    await b.send('Page.stopScreencast'); await b.detach()
    expect(h.calls.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(1)
    expect(h.calls.filter(c => c.cmd === 'cdp_detach')).toHaveLength(1)
    await h.host.shutdown()
  })

  it('cleans up when the request is already aborted before stream creation', async () => {
    const h = harness()
    const abort = new AbortController(); abort.abort()
    const response = await h.route('stream?frames=1', undefined, abort.signal)
    await response!.text()
    expect(h.hub.size).toBe(0)
    await h.host.shutdown()
  })

  it('collects only completed matching JSON responses and releases its observer', async () => {
    const h = harness()
    const result = collectPassiveResponses(h.set.pages()[0], { fragments: ['/jobs'], durationMs: 1000, max: 1 })
    await until(() => h.calls.some(c => c.method === 'Network.enable'))
    h.emit({ kind: 'event', tabId: 7, method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { method: 'POST' } } })
    h.emit({ kind: 'event', tabId: 7, method: 'Network.responseReceived', params: { requestId: 'r1', response: { url: 'https://example.test/jobs', status: 200 } } })
    expect(h.calls.some(c => c.method === 'Network.getResponseBody')).toBe(false)
    h.emit({ kind: 'event', tabId: 7, method: 'Network.loadingFinished', params: { requestId: 'r1' } })
    expect(await result).toEqual([expect.objectContaining({ method: 'POST', status: 200, json: { jobs: [1] } })])
    await until(() => h.calls.some(c => c.cmd === 'cdp_detach'))
    await h.host.shutdown()
  })

  it('handles file selection inside the product and releases interception on handback', async () => {
    const h = harness()
    await h.route('control', { control: 'human' })
    await h.route('input', { type: 'click', x: 10, y: 10 })
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } }))
    h.emit({ kind: 'event', tabId: 7, method: 'Page.fileChooserOpened', params: { backendNodeId: 5, mode: 'selectSingle' } })
    await until(() => !!h.files.current())
    const pending = h.files.current()!
    expect(pending.accept).toBe('.pdf')
    const response = await h.route('file', { id: pending.id, files: [{ name: 'resume.pdf', mimeType: 'application/pdf', data: 'JVBERi10ZXN0' }] })
    expect(await response!.json()).toMatchObject({ ok: true, count: 1 })
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'Runtime.callFunctionOn', params: expect.objectContaining({ arguments: [{ value: [{ name: 'resume.pdf', mimeType: 'application/pdf', data: 'JVBERi10ZXN0' }] }] }) }))
    await h.route('control', { control: 'agent' })
    await until(() => h.calls.some(c => c.method === 'Page.setInterceptFileChooserDialog' && (c.params as { enabled: boolean }).enabled === false))
    expect(h.files.current()).toBeNull()
    await h.host.shutdown()
  })

  it('uploads the actual local attachment bytes, never an empty placeholder', async () => {
    const h = harness()
    const dir = await mkdtemp(join(tmpdir(), 'bridge-upload-'))
    try {
      const path = join(dir, 'resume.pdf')
      await writeFile(path, '%PDF-test-resume')
      await h.set.pages()[0].setInputFiles('input[type=file]', path)
      const code = h.bridge.executeJs.mock.calls.at(-1)?.[1]
      expect(code).toContain(Buffer.from('%PDF-test-resume').toString('base64'))
      expect(code).toContain('resume.pdf')
      expect(code).toContain('application/pdf')
    } finally { await rm(dir, { recursive: true, force: true }); await h.host.shutdown() }
  })

  it('removes context listeners and marks externally closed pages closed without sending tabs.close', async () => {
    const h = harness()
    const listener = vi.fn()
    h.context.on('page', listener)
    h.context.off('page', listener)
    const old = h.set.pages()[0]
    const closed = vi.fn()
    old.once('close', closed)
    h.tabs([{ id: 8, url: 'https://example.test/new', title: 'New' }])
    expect(listener).not.toHaveBeenCalled()
    expect(old.isClosed()).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
    h.host.focusPage('career', h.set.pages()[0] as unknown as Page)
    await h.host.shutdown()
    expect(h.calls.some(c => c.cmd === 'tabs')).toBe(false)
  })
})
