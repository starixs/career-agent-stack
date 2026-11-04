import type { PageLike } from './page.js'
import type { PageScript } from './scripts.js'
import { clickText, confirmSent } from './login.js'
import { WIDGET_SCRIPT_IDS } from './widgets.js'

/**
 * 图形验证码（2026-11-03 中国中车：点「获取验证码」后格子里弹出一张扭曲字母图 + 「确认发送」）：
 * 这是网站要人看的，**不识别、不代填**。只把图和格子找出来：图交给产品原样给他看，他打的字填回格子、点确认，
 * 后面的发码、收码、登录接着自动办（用户 2026-11-03：「本质上是要减少用户不必要的操作」）。
 */

export interface ImageCodeTarget { input: string; image: string }

/** 图形码图片的大小：比按钮大、比二维码小（二维码多是 120px 以上的正方形）。 */
export const imageCodeScript: PageScript<null, ImageCodeTarget | null> = {
  id: WIDGET_SCRIPT_IDS.imageCode,
  fn: () => {
    const seen = (n: Element) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const looksCode = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 50 && r.width <= 220 && r.height >= 18 && r.height <= 90 && r.width > r.height * 1.4 }
    for (const n of Array.from(document.querySelectorAll('[data-career-imgcode]'))) n.removeAttribute('data-career-imgcode')
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => seen(i) && !i.value && /(验证码|图形码|校验码|图片码|captcha)/i.test(`${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.name}`))
    for (const input of inputs) {
      let box: Element | null = input.parentElement
      for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
        const img = Array.from(box.querySelectorAll('img, canvas')).find(x => seen(x) && looksCode(x))
        if (!img) continue
        input.setAttribute('data-career-imgcode', 'input')
        img.setAttribute('data-career-imgcode', 'img')
        document.documentElement.setAttribute('data-career-imgcode-seen', '1')
        return { input: '[data-career-imgcode="input"]', image: '[data-career-imgcode="img"]' }
      }
    }
    return null
  },
}

const CONFIRM_RX = '^(确认发送|确定|确认|发送|提交|获取验证码|发送验证码|下一步)$'

export async function findImageCode(page: PageLike): Promise<ImageCodeTarget | null> {
  return page.evaluate(imageCodeScript, null)
}

export type ImageCodeAnswerResult = { status: 'sent' } | { status: 'captcha'; evidence: string } | { status: 'image_code' } | { status: 'unseen' }

/** 把他看图打的字填回去、点确认；再看一眼：发出去了 / 换了一张（打错了）/ 别的人机验证。 */
export async function answerImageCode(page: PageLike, text: string, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<ImageCodeAnswerResult> {
  const sleep = opts.sleep ?? (ms => page.waitForTimeout(ms))
  const target = await findImageCode(page)
  if (!target) return { status: 'unseen' }
  await page.fill(target.input, text.trim())
  await clickText(page, CONFIRM_RX, false, target.input)
  const after = await confirmSent(page, sleep)
  if (after.status === 'unseen' && await findImageCode(page)) return { status: 'image_code' }
  return after
}

/** 图形码的图转成 data URL 给产品显示（同源图片 / canvas 直接取；跨域取不到返回 null，由调用方退到截图）。 */
export const imageCodeDataScript: PageScript<null, string | null> = {
  id: WIDGET_SCRIPT_IDS.imageCodeData,
  fn: () => {
    const el = document.querySelector('[data-career-imgcode="img"]')
    if (!el) return null
    try {
      if (el instanceof HTMLCanvasElement) return el.toDataURL('image/png')
      if (!(el instanceof HTMLImageElement) || !el.complete || !el.naturalWidth) return null
      const c = document.createElement('canvas')
      c.width = el.naturalWidth; c.height = el.naturalHeight
      c.getContext('2d')?.drawImage(el, 0, 0)
      return c.toDataURL('image/png')
    } catch (e) {
      console.warn('[apply-imgcode] 取图失败（多半是跨域图片）', e)
      return null
    }
  },
}

export async function imageCodeDataUrl(page: PageLike): Promise<string | null> {
  return page.evaluate(imageCodeDataScript, null)
}

/** 点一下换一张最多等多久、隔多久看一眼（图是异步换的）。 */
const REFRESH_WAIT_MS = 2000
const REFRESH_POLL_MS = 250

/**
 * 他看不清、点了产品里那张图：替他点网站上的图换一张（多数站点图就换，和他在浏览器里点一样，2026-11-03 CAS-7），
 * 返回新图（跨域取不到返回 null，由调用方照旧显示）。页面上没有图形码返回 undefined。
 */
export async function refreshImageCode(page: PageLike, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<string | null | undefined> {
  const sleep = opts.sleep ?? (ms => page.waitForTimeout(ms))
  const target = await findImageCode(page)
  if (!target) return undefined
  const before = await imageCodeDataUrl(page)
  await page.click(target.image)
  let now: string | null = before
  for (let waited = 0; waited < REFRESH_WAIT_MS; waited += REFRESH_POLL_MS) {
    await sleep(REFRESH_POLL_MS)
    if (!(await findImageCode(page))) return undefined
    now = await imageCodeDataUrl(page)
    if (now && now !== before) return now
  }
  console.warn('[apply-imgcode] 点了图没换（这家可能要点旁边的「换一张」），照旧给原图')
  return now
}

/**
 * 他直接在网页上答了图形码（2026-11-03 中国中车：他在画面里打字点「确认发送」，产品那一格一直没收到）：
 * 之前标过的那张图不在了 / 看不见了，就当他答完了。还没标过图返回 false。
 */
export const imageCodeGoneScript: PageScript<null, boolean> = {
  id: WIDGET_SCRIPT_IDS.imageCodeGone,
  fn: () => {
    if (!document.documentElement.hasAttribute('data-career-imgcode-seen')) return false
    const seen = (n: Element) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const el = document.querySelector('[data-career-imgcode="img"]')
    if (el && seen(el)) return false
    // 标过的那张没了：可能只是网站换了一张（新元素）。旁边还挂着图形码格子 + 图就还没答完（他在格子里打着字也算）
    const looksCode = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 50 && r.width <= 220 && r.height >= 18 && r.height <= 90 && r.width > r.height * 1.4 }
    for (const input of Array.from(document.querySelectorAll('input')).filter(i => seen(i) && /(验证码|图形码|校验码|图片码|captcha)/i.test(`${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.name}`))) {
      let box: Element | null = input.parentElement
      for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
        const img = Array.from(box.querySelectorAll('img, canvas')).find(x => seen(x) && looksCode(x))
        if (img) { img.setAttribute('data-career-imgcode', 'img'); return false }
      }
    }
    return true
  },
}

export async function imageCodeGone(page: PageLike): Promise<boolean> {
  return page.evaluate(imageCodeGoneScript, null)
}
