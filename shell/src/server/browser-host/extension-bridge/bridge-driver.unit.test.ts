import { describe, it, expect, vi } from 'vitest'
import { BridgeCaptchaPage, BridgeCdpSession, bridgePageFor, startTabScreencast, type BridgeEventSource, type BridgeLike } from './bridge-driver'
import type { BridgeCdpEvent, BridgeTab } from './extension-bridge'

/**
 * BridgeDriver 单测：假桥（记录 executeJs / sendCommand）验证
 * 「用户真实 Chrome 的标签页」被正确包装成 CaptchaPage。
 */

const TAB: BridgeTab = { id: 42, url: 'https://www.zhipin.com/web/geek/job', title: 'BOSS直聘' }

function fakeBridge(overrides: Partial<Record<keyof BridgeLike, unknown>> = {}): BridgeLike {
  const base: BridgeLike = {
    isConnected: () => true,
    tabs: () => [TAB],
    findTab: (p: string) => (TAB.url.includes(p) ? TAB : null),
    executeJs: vi.fn(async (tabId: number, code: string) => ({ data: evalShim(tabId, code) })),
    sendCommand: vi.fn(async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === 'cdp' && cmd.method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') }
      if (cmd.cmd === 'tabs' && cmd.method === 'create') return { id: 99, url: 'https://www.zhipin.com/', title: '' }
      return {}
    }) as unknown as BridgeLike['sendCommand'],
  }
  return { ...base, ...(overrides as Partial<BridgeLike>) }
}

/** 极小 eval：只支持求解器/驱动里用到的几个表达式形态。 */
function evalShim(_tabId: number, code: string): unknown {
  if (code.includes('window.innerWidth')) return { width: 1366, height: 768 }
  return null
}

describe('BridgeCaptchaPage', () => {
  it('evalJson 走 executeJs(tabId, code)，data 透传', async () => {
    const bridge = fakeBridge()
    const page = new BridgeCaptchaPage(bridge, TAB, async () => {})
    const vp = await page.viewport()
    expect(vp).toEqual({ width: 1366, height: 768 })
    expect(bridge.executeJs).toHaveBeenCalledWith(42, 'return { width: window.innerWidth, height: window.innerHeight }')
  })

  it('screenshot 走 CDP Page.captureScreenshot → base64 解码', async () => {
    const bridge = fakeBridge()
    const page = new BridgeCaptchaPage(bridge, TAB, async () => {})
    const bytes = await page.screenshot()
    expect(Buffer.from(bytes).toString()).toBe('png')
    expect(bridge.sendCommand).toHaveBeenCalledWith({ cmd: 'cdp', tabId: 42, method: 'Page.captureScreenshot', params: { format: 'png' } })
  })

  it('cdp() 在桥连接时可用、断开时为 null', async () => {
    const bridge = fakeBridge()
    const page = new BridgeCaptchaPage(bridge, TAB, async () => {})
    expect(page.cdp()).toBeInstanceOf(BridgeCdpSession)
    const dead = fakeBridge({ isConnected: () => false })
    expect(new BridgeCaptchaPage(dead, TAB, async () => {}).cdp()).toBeNull()
  })

  it('url 取自 tab', () => {
    expect(new BridgeCaptchaPage(fakeBridge(), TAB).url()).toBe(TAB.url)
  })
})

describe('BridgeCdpSession', () => {
  it("send 把 CDP 方法原样路由到扩展（cmd:'cdp'）", async () => {
    const bridge = fakeBridge()
    const session = new BridgeCdpSession(bridge, 42)
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 })
    expect(bridge.sendCommand).toHaveBeenCalledWith({ cmd: 'cdp', tabId: 42, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2 } })
  })
})

describe('bridgePageFor', () => {
  it('已有该站点 tab 直接复用（登录态就在里面）', async () => {
    const page = await bridgePageFor(fakeBridge(), 'zhipin')
    expect(page?.tab.id).toBe(42)
    expect(page?.url()).toContain('zhipin')
  })
  it('没有就开后台 tab（active:false 不抢用户当前页）', async () => {
    const bridge = fakeBridge({
      findTab: () => null,
      sendCommand: vi.fn(async () => ({ id: 99, url: 'https://www.zhipin.com/', title: '' })),
    })
    const page = await bridgePageFor(bridge, 'zhipin', 'https://www.zhipin.com/')
    expect(page?.tab.id).toBe(99)
    expect(bridge.sendCommand).toHaveBeenCalledWith({ cmd: 'tabs', method: 'create', url: 'https://www.zhipin.com/', active: false })
  })
  it('桥断开返回 null', async () => {
    expect(await bridgePageFor(fakeBridge({ isConnected: () => false }), 'zhipin')).toBeNull()
  })
  it('开不出来返回 null', async () => {
    const bridge = fakeBridge({ findTab: () => null, sendCommand: vi.fn(async () => ({})) })
    expect(await bridgePageFor(bridge, 'zhipin', 'https://www.zhipin.com/')).toBeNull()
  })
})

/** 带事件上行的假桥（screencast 用）。 */
function eventBridge() {
  const listeners = new Set<(e: BridgeCdpEvent) => void>()
  const disconnects = new Set<() => void>()
  const commands: Array<Record<string, unknown>> = []
  const bridge: BridgeLike & BridgeEventSource = {
    ...fakeBridge(),
    onCdpEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    onDisconnect: (cb) => { disconnects.add(cb); return () => disconnects.delete(cb) },
    sendCommand: async <T,>(cmd: Record<string, unknown>): Promise<T> => {
      commands.push(cmd)
      return {} as T
    },
  }
  return {
    bridge,
    commands,
    emit: (e: BridgeCdpEvent) => { for (const cb of listeners) cb(e) },
    drop: () => { for (const cb of disconnects) cb() },
  }
}

describe('startTabScreencast（产品内现场画面的桥数据源）', () => {
  it('attach → startScreencast，帧上行回调并逐帧 ACK，stop 停流并 detach', async () => {
    const h = eventBridge()
    const frames: Array<{ data: string }> = []
    const cast = await startTabScreencast(h.bridge, 42, f => frames.push(f))
    expect(h.commands[0]).toMatchObject({ cmd: 'cdp_attach', tabId: 42 })
    expect(h.commands[1]).toMatchObject({ cmd: 'cdp', tabId: 42, method: 'Page.startScreencast' })
    h.emit({ kind: 'event', tabId: 42, method: 'Page.screencastFrame', params: { data: 'ZjE=', sessionId: 's1' } })
    h.emit({ kind: 'event', tabId: 42, method: 'Page.screencastFrame', params: { data: 'ZjI=', sessionId: 's2' } })
    // 其他 tab 的事件不进来
    h.emit({ kind: 'event', tabId: 7, method: 'Page.screencastFrame', params: { data: 'bm8=', sessionId: 's3' } })
    await Promise.resolve()
    expect(frames.map(f => f.data)).toEqual(['ZjE=', 'ZjI='])
    const acks = h.commands.filter(c => c.method === 'Page.screencastFrameAck')
    expect(acks.map(a => (a.params as { sessionId: string }).sessionId)).toEqual(['s1', 's2'])
    await cast.stop()
    expect(h.commands.at(-2)).toMatchObject({ method: 'Page.stopScreencast' })
    expect(h.commands.at(-1)).toMatchObject({ cmd: 'cdp_detach', tabId: 42 })
  })

  it('用户点黄条取消（cdp_detached）→ 回调 onDetached，stop 不再重复 detach', async () => {
    const h = eventBridge()
    const detached: string[] = []
    const cast = await startTabScreencast(h.bridge, 42, () => {}, { onDetached: r => detached.push(r) })
    const before = h.commands.length
    h.emit({ kind: 'detached', tabId: 42, reason: 'canceled_by_user' })
    expect(detached).toEqual(['canceled_by_user'])
    await cast.stop()
    expect(h.commands.length).toBe(before) // 已失效：不再补发 stop/detach
  })

  it('桥整体断开也触发 onDetached', async () => {
    const h = eventBridge()
    const detached: string[] = []
    const cast = await startTabScreencast(h.bridge, 42, () => {}, { onDetached: r => detached.push(r) })
    h.drop()
    expect(detached).toEqual(['bridge-disconnected'])
    await cast.stop()
  })
})
