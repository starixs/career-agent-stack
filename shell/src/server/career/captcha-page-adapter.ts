import type { Page } from 'playwright'
import type { CaptchaPage, CdpSessionLike } from '@career/captcha'

/**
 * playwright Page → @career/captcha 的 CaptchaPage 适配。
 * CDP 会话按页缓存（每页一个，页面关闭时自动 detach）。
 */

const cdpCache = new WeakMap<Page, Promise<CdpSessionLike>>()

function cdpFor(page: Page): CdpSessionLike {
  let p = cdpCache.get(page)
  if (!p) {
    p = (async () => {
      const session = await page.context().newCDPSession(page)
      page.once('close', () => { void session.detach().catch(() => {}) })
      return session as unknown as CdpSessionLike
    })()
    cdpCache.set(page, p)
  }
  return wrapPromise(p)
}

/** pending 中的 session 也要能用（send 排队到 ready 之后）。 */
function wrapPromise(p: Promise<CdpSessionLike>): CdpSessionLike {
  return {
    async send(method: string, params?: Record<string, unknown>) {
      const session = await p
      return session.send(method, params)
    },
  }
}

export function captchaPageFromPlaywright(page: Page): CaptchaPage {
  return {
    url: () => page.url(),
    async evalJson<T>(expr: string): Promise<T> {
      return page.evaluate(expr) as Promise<T>
    },
    async screenshot() {
      const buf = await page.screenshot({ type: 'png' })
      return new Uint8Array(buf)
    },
    cdp: () => (page.isClosed() ? null : cdpFor(page)),
    async viewport() { return page.viewportSize() },
    waitForTimeout: ms => page.waitForTimeout(ms),
  }
}
