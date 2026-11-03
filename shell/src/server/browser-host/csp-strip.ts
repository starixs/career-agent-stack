import type { BrowserContext, Page } from 'playwright-core'

/**
 * CSP 头剥离：托管浏览器侧给每个页面挂 CDP `Fetch` 域，把响应里的
 * `content-security-policy` 头去掉——注入脚本就能在任意站的主世界 eval。
 * （扩展桥形态下等价能力来自扩展的 declarativeNetRequest 规则。）
 * 失败只降级不阻塞：剥不掉的站照常跑，只是注入兜底不可用。
 */

const CSP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
])

export function cspStripEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAREER_BROWSER_STRIP_CSP !== '0'
}

export interface CspStripHandle {
  detach(): void
}

/** 给 Context 的每个页面挂 CSP 剥离（含已存在的页面）。 */
export function attachCspStrip(context: BrowserContext, log: (msg: string) => void = console.warn): CspStripHandle {
  const strips = new Set<Promise<void>>()

  const stripPage = async (page: Page): Promise<void> => {
    if (page.isClosed()) return
    try {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Response' }],
      })
      cdp.on('Fetch.requestPaused', async (event: { requestId: string; responseHeaders?: Array<{ name: string; value: string }> }) => {
        const headers = (event.responseHeaders ?? []).filter(h => !CSP_HEADERS.has(h.name.toLowerCase()))
        try {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId, headers })
        } catch {
          // 请求可能已被导航作废；忽略
        }
      })
      page.once('close', () => { void cdp.detach().catch(() => {}) })
    } catch (e) {
      log(`[browser-host] csp-strip attach failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onPage = (page: Page) => { strips.add(stripPage(page)) }
  context.on('page', onPage)
  context.pages().forEach(onPage)
  return {
    detach() {
      context.off('page', onPage)
    },
  }
}
