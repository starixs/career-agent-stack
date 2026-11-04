import { describe, it, expect } from 'vitest'
import { BridgePageProxy, BridgePageProxySet, type BridgeTabsSource } from './bridge-page-proxy'
import type { BridgeCdpEvent, BridgeTab } from './extension-bridge'
import type { BridgeEventSource, BridgeLike } from './bridge-driver'

/**
 * BridgePageProxy 单测：假桥（executeJs 记录 + 按表达式回放）验证融合层
 * 把真实 Chrome 标签页扮演成 playwright Page 引擎面的全部路径。
 */

const TAB: BridgeTab = { id: 7, url: 'https://www.zhipin.com/web/geek/job?query=算法', title: 'BOSS直聘' }

interface CdpCall { cmd: string; method?: string; tabId?: number; params?: Record<string, unknown>; url?: string; active?: boolean }

function proxyHarness() {
  const execCalls: Array<{ tabId: number; code: string }> = []
  const cdpCalls: CdpCall[] = []
  const tabListeners = new Set<(tabs: BridgeTab[]) => void>()
  const cdpListeners = new Set<(e: BridgeCdpEvent) => void>()
  const disconnects = new Set<() => void>()
  const bridge: BridgeLike & BridgeEventSource & BridgeTabsSource = {
    isConnected: () => true,
    tabs: () => [TAB],
    findTab: (p: string) => (TAB.url.includes(p) ? TAB : null),
    executeJs: async (tabId: number, code: string) => {
      execCalls.push({ tabId, code })
      return { data: evalShim(code) }
    },
    sendCommand: async <T,>(cmd: Record<string, unknown>): Promise<T> => {
      cdpCalls.push(cmd as unknown as CdpCall)
      if (cmd.cmd === 'tabs' && cmd.method === 'create') return { id: 99, url: String(cmd.url ?? 'about:blank'), title: '' } as T
      return {} as T
    },
    onTabsChange: cb => { tabListeners.add(cb); return () => tabListeners.delete(cb) },
    onCdpEvent: cb => { cdpListeners.add(cb); return () => cdpListeners.delete(cb) },
    onDisconnect: cb => { disconnects.add(cb); return () => disconnects.delete(cb) },
  }
  const set = new BridgePageProxySet({ bridge, tabs: bridge, rand: () => 0.5, sleep: async () => {} })
  // 构造时已订阅 onTabsChange：首灌（首次同步只填充、不触发 popup）
  for (const cb of tabListeners) cb([TAB])
  const page = set.get(7)!
  return {
    bridge, set, page, execCalls, cdpCalls,
    emitTabs: (tabs: BridgeTab[]) => { for (const cb of tabListeners) cb(tabs) },
    emitCdp: (e: BridgeCdpEvent) => { for (const cb of cdpListeners) cb(e) },
  }
}

/** 表达式回放：覆盖融合层发出的全部探针（注意顺序——'querySelectorAll' 含 'querySelector' 子串、
 *  isVisible 探针里也有 getBoundingClientRect）。 */
function evalShim(code: string): unknown {
  if (code.includes('document.title')) return 'BOSS直聘'
  if (code.includes('document.readyState')) return 'complete'
  if (code.includes('outerHTML')) return '<html><body>岗位列表</body></html>'
  if (code.includes('innerWidth')) return { width: 1366, height: 768 }
  if (code.includes('location.href')) return true
  if (code.startsWith('(() => { const __name') && code.includes('arg')) return 'fn-result'
  if (code.includes('visibility')) return true // isVisible 探针（先于 rect：它也取 getBoundingClientRect）
  if (code.includes('getBoundingClientRect')) return { x: 100, y: 200, width: 80, height: 30 }
  if (code.includes('querySelectorAll')) return 1
  if (code.includes('innerText')) return '立即投递'
  if (code.includes('querySelector')) return true // fill/select/scroll 探针统一 true
  if (code.includes('history.back')) return true
  return null
}

describe('BridgePageProxy 基础面', () => {
  it('url/title/mainFrame 身份（跨借用稳定）', async () => {
    const { page } = proxyHarness()
    expect(page.url()).toContain('zhipin')
    expect(await page.title()).toBe('BOSS直聘')
    expect(page.mainFrame()).toBe(page.mainFrame())
  })

  it('evaluate：字符串原样；函数包成 IIFE（与 browse inPage 同构）', async () => {
    const { page, execCalls } = proxyHarness()
    await page.evaluate('return document.title')
    expect(execCalls.at(-1)!.code).toBe('return document.title')
    const fn = (arg: { x: number }) => arg.x + 1
    await page.evaluate(fn, { x: 41 })
    expect(execCalls.at(-1)!.code).toContain('__name')
    expect(execCalls.at(-1)!.code).toContain('{"x":41}')
  })

  it('goto uses Chrome tabs navigation, including blank pages with a live screenshot lease', async () => {
    const { page, execCalls, cdpCalls } = proxyHarness()
    await page.goto('https://www.liepin.com/')
    expect(cdpCalls).toContainEqual({ cmd: 'tabs', method: 'navigate', tabId: 7, url: 'https://www.liepin.com/' })
    expect(execCalls.some(c => c.code.includes('window.location.href ='))).toBe(false)
  })

  it('a pre-creation tab snapshot cannot close a newly returned page', async () => {
    const { set, emitTabs } = proxyHarness()
    const fresh = await set.toContext().newPage()
    emitTabs([TAB])
    expect(fresh.isClosed()).toBe(false)
    emitTabs([TAB, { id: 99, url: 'about:blank', title: '' }])
    emitTabs([TAB])
    expect(fresh.isClosed()).toBe(true)
  })

  it('evaluate 失败附导航上下文销毁关键词（browse 的 CONTEXT_GONE 重试能接住）', async () => {
    const { page, bridge } = proxyHarness()
    bridge.executeJs = async () => { throw new Error('frame detached') }
    await expect(page.evaluate('return 1')).rejects.toThrow(/target navigated/)
  })
})

describe('可信输入（CDP 三事件）', () => {
  it('mouse.click：cdp_attach → 三事件序列', async () => {
    const { page, cdpCalls } = proxyHarness()
    await page.mouse.click(140, 215)
    expect(cdpCalls[0]).toMatchObject({ cmd: 'cdp_attach', tabId: 7 })
    const input = cdpCalls.filter(c => c.cmd === 'cdp' && c.method?.startsWith('Input.'))
    const types = input.map(c => (c.params as { type: string }).type)
    const pressed = types.indexOf('mousePressed')
    expect(types[types.length - 1]).toBe('mouseReleased')
    expect(types.slice(0, pressed).every(t => t === 'mouseMoved')).toBe(true)
    expect(types[0]).toBe('mouseMoved') // 预热
  })

  it('keyboard.type：逐字符 keyDown/keyUp', async () => {
    const { page, cdpCalls } = proxyHarness()
    await page.keyboard.type('AB')
    const keys = cdpCalls.filter(c => c.method === 'Input.dispatchKeyEvent')
    expect(keys.length).toBe(4)
    expect((keys[0].params as { text: string }).text).toBe('A')
  })
})

describe('DOM 操作面（apply PageLike 底层）', () => {
  it('activates the working tab and attaches before measuring click coordinates', async () => {
    const { page, bridge, execCalls, cdpCalls } = proxyHarness()
    const send = bridge.sendCommand
    bridge.sendCommand = async <T,>(cmd: Record<string, unknown>, timeout?: number): Promise<T> => {
      if (cmd.method === 'Page.bringToFront') expect(execCalls).toHaveLength(0)
      return send<T>(cmd, timeout)
    }
    await page.click('#send')
    expect(cdpCalls.some(c => c.method === 'Page.bringToFront')).toBe(true)
  })

  it('fill：JS 赋值 + input/change 事件', async () => {
    const { page, execCalls } = proxyHarness()
    await page.fill('input[name=name]', '张三')
    const code = execCalls.at(-1)!.code
    expect(code).toContain('input[name=name]')
    expect(code).toContain('张三')
    expect(code).toContain("new Event('input'")
  })

  it('click：rect 中心走 CDP 可信点击', async () => {
    const { page, cdpCalls } = proxyHarness()
    await page.click('button.submit')
    const press = cdpCalls.find(c => c.method === 'Input.dispatchMouseEvent' && (c.params as { type: string }).type === 'mousePressed')!
    expect(press.params!.x).toBeCloseTo(140, 1) // 100 + 80/2
    expect(press.params!.y).toBeCloseTo(215, 1)
  })

  it('setInputFiles：DataTransfer 方案（不走 CDP setFileInputFiles）', async () => {
    const { page, execCalls } = proxyHarness()
    await page.setUploadFiles('input[type=file]', [{ name: 'resume.pdf', type: 'application/pdf', base64: 'JVBERi' }])
    const code = execCalls.at(-1)!.code
    expect(code).toContain('DataTransfer')
    expect(code).toContain('resume.pdf')
    expect(code).not.toContain('setFileInputFiles')
  })

  it('locator：count/innerText/isVisible/fill 串起来', async () => {
    const { page } = proxyHarness()
    expect(await page.locator('button').count()).toBe(1)
    expect(await page.locator('button').innerText()).toBe('立即投递')
    expect(await page.locator('button').isVisible()).toBe(true)
    await expect(page.locator('input').fill('x')).resolves.toBeUndefined()
  })
})

describe('BridgePageProxySet（context 面）', () => {
  it('tabs_update 同步：新标签触发 once(popup) 与 on(page)，首次同步不触发', async () => {
    const h = proxyHarness()
    const popups: number[] = []
    const pages: number[] = []
    h.page.once('popup', p => popups.push((p as unknown as BridgePageProxy).tab.id))
    const off = h.set.onPage(p => pages.push(p.tab.id))
    h.emitTabs([TAB, { id: 9, url: 'https://new.example.com/', title: '新页' }]) // 非首次 → 触发
    expect(popups).toEqual([9])
    expect(pages).toEqual([9])
    off()
  })

  it('context.pages()/newPage()（引擎 tabsOf / app-pages 用）', async () => {
    const h = proxyHarness()
    const ctx = h.set.toContext() as { pages(): BridgePageProxy[]; newPage(): Promise<BridgePageProxy>; on(ev: string, cb: (p: BridgePageProxy) => void): void }
    expect(ctx.pages().map(p => p.tab.id)).toEqual([7])
    const opened: number[] = []
    ctx.on('page', p => opened.push(p.tab.id))
    const fresh = await ctx.newPage()
    expect(fresh.url()).toBe('about:blank')
    expect(opened).toEqual([fresh.tab.id])
    expect(h.cdpCalls.some(c => c.cmd === 'tabs' && c.method === 'create')).toBe(true)
  })

  it('close：tabs close 命令发出，从集合摘除', async () => {
    const h = proxyHarness()
    await h.page.close()
    expect(h.cdpCalls.some(c => c.cmd === 'tabs' && c.method === 'close' && c.tabId === 7)).toBe(true)
    expect(h.set.get(7)).toBeUndefined()
  })

  it('openOrFind：已有匹配直接复用（登录态就在里面）', async () => {
    const h = proxyHarness()
    const page = await h.set.openOrFind('zhipin', 'https://www.zhipin.com/')
    expect(page?.tab.id).toBe(7)
    expect(h.cdpCalls.filter(c => c.cmd === 'tabs' && c.method === 'create').length).toBe(0)
  })
})

// 把内部 syncTabs 挂到原型上供测试首灌（不进生产路径）
