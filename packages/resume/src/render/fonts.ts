/**
 * 中文字体方案：@fontsource/noto-sans-sc 把 Noto Sans SC 按 unicode-range 切成约 100 个子集（woff）。
 * react-pdf 的 fontFamily 支持数组（逐字符回退），所以把每个子集注册成独立字体族，
 * 按简历文本实际用到的码点只注册/加载需要的子集。拉丁字符走内置 Times-Roman / Times-Bold。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Font } from '@react-pdf/renderer'

const require = createRequire(import.meta.url)

let fontDir: string | null = null
export function notoSansScDir(): string {
  if (!fontDir) fontDir = dirname(require.resolve('@fontsource/noto-sans-sc/package.json'))
  return fontDir
}

export interface FontSubset { index: number; ranges: Array<[number, number]> }

const subsetCache = new Map<number, FontSubset[]>()

/** 解析 fontsource 的 {weight}.css，得到每个子集覆盖的码点区间。 */
export function loadSubsets(weight: 400 | 700 = 400): FontSubset[] {
  const cached = subsetCache.get(weight)
  if (cached) return cached
  const css = readFileSync(join(notoSansScDir(), `${weight}.css`), 'utf8')
  const out: FontSubset[] = []
  for (const block of css.split('@font-face')) {
    const m = block.match(/noto-sans-sc-(\d+)-\d+-normal\.woff\)/)
    const ur = block.match(/unicode-range:\s*([^;]+);/)
    if (!m || !ur) continue
    const ranges: Array<[number, number]> = []
    for (const part of ur[1].split(',')) {
      const p = part.trim().replace(/^U\+/i, '')
      if (!p) continue
      const [a, b] = p.split('-')
      if (a.includes('?')) { ranges.push([parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'f'), 16)]); continue }
      const lo = parseInt(a, 16); const hi = b ? parseInt(b, 16) : lo
      if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi])
    }
    out.push({ index: Number(m[1]), ranges })
  }
  subsetCache.set(weight, out)
  return out
}

/** 文本用到的子集编号（去重、升序）。ASCII 由内置字体负责，不算在内。 */
export function subsetsForText(text: string, weight: 400 | 700 = 400): number[] {
  const subsets = loadSubsets(weight)
  const need = new Set<number>()
  const seen = new Set<number>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80 || seen.has(cp)) continue
    seen.add(cp)
    const hit = subsets.find(s => s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi))
    if (hit) need.add(hit.index)
  }
  return [...need].sort((a, b) => a - b)
}

export function subsetFamily(index: number): string { return `NotoSansSC-${index}` }

const registered = new Set<number>()

/** 注册指定子集（幂等）。400 与 700 两档都注册到同一个字体族。 */
export function registerSubsets(indices: number[]): string[] {
  const dir = join(notoSansScDir(), 'files')
  const families: string[] = []
  for (const i of indices) {
    const family = subsetFamily(i)
    if (!registered.has(i)) {
      const regular = join(dir, `noto-sans-sc-${i}-400-normal.woff`)
      const bold = join(dir, `noto-sans-sc-${i}-700-normal.woff`)
      if (!existsSync(regular)) continue
      const fonts = [{ src: regular, fontWeight: 400 as const }]
      if (existsSync(bold)) fonts.push({ src: bold, fontWeight: 700 as unknown as 400 })
      Font.register({ family, fonts })
      registered.add(i)
    }
    families.push(family)
  }
  return families
}

export interface FontStack { regular: string[]; bold: string[] }

/** 为一段文本准备字体栈：内置 Times 在前，需要的中文子集在后。 */
export function fontStackFor(text: string): FontStack {
  const families = registerSubsets(subsetsForText(text))
  return { regular: ['Times-Roman', ...families], bold: ['Times-Bold', ...families] }
}

const CJK_CHAR = /[⺀-鿿豈-﫿＀-￯　-〿]/

/**
 * 断行回调：react-pdf 只在空格处分词，中文整段会被当成一个"单词"。
 * 把 CJK 字符逐个拆开（react-pdf 在断点不画连字符），拉丁单词保持完整。
 */
export function cjkHyphenation(word: string): string[] {
  if (!CJK_CHAR.test(word)) return [word]
  const parts: string[] = []
  let latin = ''
  for (const ch of word) {
    if (CJK_CHAR.test(ch)) { if (latin) { parts.push(latin); latin = '' } parts.push(ch) }
    else latin += ch
  }
  if (latin) parts.push(latin)
  return parts
}
