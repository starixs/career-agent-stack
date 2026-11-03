import { describe, it, expect, vi } from 'vitest'
import { BridgeCaptchaPage, BridgeCdpSession, bridgePageFor, type BridgeLike } from './bridge-driver'
import type { BridgeTab } from './extension-bridge'

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
