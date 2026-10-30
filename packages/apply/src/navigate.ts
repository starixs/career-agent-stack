import type { SiteAdapter } from './adapters/types.js'
import type { PageLike } from './page.js'
import type { PageScript } from './scripts.js'

/**
 * 从校招首页 / 合集页走到具体岗位详情页。
 *
 * 前提（立场 10，2026-10-30）：岗位库里能找到的岗位就一定能投；库里多是「XX 公司 2027 校招」「软件类 / 通信类 / IC 类」
 * 这一层，打开是首页或岗位列表，不是网申表（2026-10-31 实例测试：Moka / 北森 / hotjob 四家全停在这里）。
 * 做法：先在页面现有的岗位链接里挑最对口的；没有就用站点搜索（适配器给的搜索网址，或页面上的搜索框）打方向词再挑。
 * 只点链接、只往搜索框里打字，不点任何按钮（申请入口和最终提交仍由 drive.ts 的守卫管）。
 */

export interface PositionTarget {
  /** 打分用的说法（方向词的同义说法 + 岗位名片段），越靠前越重要。 */
  terms: string[]
  /** 往站点搜索框里打的词，按顺序试。 */
  search: string[]
  /** 加分项（期望城市等），不命中也不排除。 */
  prefer?: string[]
}

export interface PositionLink { selector: string; href: string; text: string }

export interface NavigateResult {
  moved: boolean
  picked?: string
  via?: 'link' | 'search_url' | 'search_box'
  tried: string[]
}

/** 每次最多试几个搜索词：站点搜索慢，三次还找不到多半是这家没开对口岗位。 */
const MAX_SEARCH_TERMS = 3
/** 链接文字太短（「首页」「更多」）不可能是岗位卡片。 */
const MIN_LINK_TEXT = 4
const JOBISH = /(工程师|开发|研发|实习|培训生|管培|专员|岗位|engineer|developer|intern|analyst|specialist)/i
const CAMPUS_BONUS = /(校招|应届|2027|27届|graduate|campus)/i

export const positionLinksScript: PageScript<null, PositionLink[]> = {
  id: 'career.positionLinks',
  fn: () => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 }
    const out: Array<{ selector: string; href: string; text: string }> = []
    let n = 0
    const push = (el: Element, href: string) => {
      const text = clean((el as HTMLElement).innerText)
      if (!text) return
      const id = String(n++)
      el.setAttribute('data-career-pos', id)
      out.push({ selector: `[data-career-pos="${id}"]`, href, text })
    }
    document.querySelectorAll('a[href]').forEach(el => {
      if (!visible(el)) return
      // 新标签页打开会脱离引擎手里的这一页
      if (el.getAttribute('target') === '_blank') el.removeAttribute('target')
      push(el, el.getAttribute('href') || '')
    })
    // 北森 / hotjob 的岗位行是可点的 div / li / tr，不是链接。手形光标会被子元素继承，
    // 所以取「从这层开始变成手形」的那一层（父元素不是手形）= 整行，而不是行里的标签小字
    const pointer = (el: Element | null) => !!el && getComputedStyle(el).cursor === 'pointer'
    document.querySelectorAll('div, li, tr, section, article').forEach(el => {
      if (!visible(el) || !pointer(el) || pointer(el.parentElement) || el.closest('a[href]') || el.querySelector('a[href]')) return
      push(el, '')
    })
    return out
  },
}

/** 「校园招聘」这类栏目入口：首页上没有岗位时先进这个栏目（hotjob、北森 zhiye 首页只有导航）。 */
export const positionSectionScript: PageScript<null, string | null> = {
  id: 'career.positionSection',
  fn: () => {
    const re = /^(校园招聘职位列表|校园招聘|校招职位|校招岗位|校园招聘岗位|应届生招聘|campus recruitment|campus|graduate)$/i
    const hits = Array.from(document.querySelectorAll('a, button, li, span, div')).filter(el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && re.test(((el as HTMLElement).innerText || '').trim()) && !el.querySelector('a, button')
    })
    // 「校园招聘职位列表」比「校园招聘」更接近岗位列表
    const best = hits.sort((a, b) => ((b as HTMLElement).innerText || '').length - ((a as HTMLElement).innerText || '').length)[0]
    if (!best) return null
    best.setAttribute('data-career-section', '1')
    if (best.getAttribute('target') === '_blank') best.removeAttribute('target')
    return '[data-career-section="1"]'
  },
}

export const positionSearchBoxScript: PageScript<null, string | null> = {
  id: 'career.positionSearchBox',
  fn: () => {
    const re = /(搜索|关键|职位|岗位|search|keyword)/i
    const boxes = Array.from(document.querySelectorAll('input')).filter(el => {
      const t = (el.type || 'text').toLowerCase()
      if (t !== 'text' && t !== 'search') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && re.test(`${el.placeholder} ${el.getAttribute('aria-label') || ''} ${el.name}`)
    })
    const box = boxes[0]
    if (!box) return null
    box.setAttribute('data-career-search', '1')
    return '[data-career-search="1"]'
  },
}

/** 英文词按整词比（「engineer」不能命中「engineering」，2026-10-31 实例测试挑错了 Quality engineering intern）。 */
function mentions(text: string, term: string): boolean {
  const t = term.toLowerCase()
  if (!/^[\x20-\x7e]+$/.test(t)) return text.includes(t)
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(text)
}

/** 一条链接像不像对口岗位：不像岗位的给 0；像岗位但一个方向词都不沾也给 0（不乱点别的岗位）。 */
export function scorePositionLink(link: PositionLink, target: PositionTarget, adapter: SiteAdapter): number {
  const text = link.text.toLowerCase()
  if (text.length < MIN_LINK_TEXT) return 0
  // 有链接样式的站只认这种链接；可点的岗位行（没有 href）按文字像不像岗位判断
  const pattern = adapter.hints.positionLink
  if (pattern && link.href ? !pattern.test(link.href) : !JOBISH.test(link.text)) return 0
  let score = 0
  target.terms.forEach((term, i) => { if (term && mentions(text, term)) score += Math.max(1, 10 - i) })
  if (!score) return 0
  for (const p of target.prefer ?? []) if (p && mentions(text, p)) score += 2
  if (CAMPUS_BONUS.test(link.text)) score += 1
  return score
}

export function pickPosition(links: readonly PositionLink[], target: PositionTarget, adapter: SiteAdapter): PositionLink | undefined {
  let best: PositionLink | undefined
  let bestScore = 0
  for (const link of links) {
    const s = scorePositionLink(link, target, adapter)
    if (s > bestScore) { best = link; bestScore = s }
  }
  return best
}

export interface NavigateOptions { settleMs?: number; log?: (msg: string) => void }

export async function navigateToPosition(page: PageLike, adapter: SiteAdapter, target: PositionTarget, opts: NavigateOptions = {}): Promise<NavigateResult> {
  const settle = Math.max(opts.settleMs ?? 1500, 0)
  const tried: string[] = []
  const tryPick = async (via: NonNullable<NavigateResult['via']>): Promise<NavigateResult | null> => {
    const links = await page.evaluate(positionLinksScript, null).catch(e => { opts.log?.(`读岗位链接失败：${e instanceof Error ? e.message : String(e)}`); return [] as PositionLink[] })
    const best = pickPosition(links, target, adapter)
    if (!best) return null
    await page.click(best.selector)
    await page.waitForTimeout(settle)
    return { moved: true, picked: best.text.slice(0, 60), via, tried }
  }
  const direct = await tryPick('link')
  if (direct) return direct
  const section = await page.evaluate(positionSectionScript, null).catch(() => null)
  if (section) {
    await page.click(section)
    await page.waitForTimeout(settle)
    tried.push('校园招聘栏目')
    const inSection = await tryPick('link')
    if (inSection) return inSection
  }
  for (const term of target.search.slice(0, MAX_SEARCH_TERMS)) {
    tried.push(term)
    const url = adapter.positionSearchUrl?.(page.url(), term)
    if (url && url !== page.url()) {
      await page.goto(url)
      await page.waitForTimeout(settle)
      const r = await tryPick('search_url')
      if (r) return r
      continue
    }
    const box = await page.evaluate(positionSearchBoxScript, null).catch(() => null)
    if (!box || !page.keyboard) break
    await page.fill(box, term)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(settle)
    const r = await tryPick('search_box')
    if (r) return r
  }
  return { moved: false, tried }
}
