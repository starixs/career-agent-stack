/**
 * 文本度量与预换行。
 * react-pdf 的排版引擎只在 ASCII 空格处分词，对中文整段当成一个"单词"；它在断字点会画连字符（中文子集字体里没有连字符 → 方框）。
 * 所以中文换行由我们自己做：按 Times-Roman AFM 宽度（西文）与 1em（CJK）精确测量，在数据层插入 '\n'，并处理行首行尾禁则。
 */

/** Times-Roman / Times-Bold 的 ASCII 32..126 advance（1/1000 em），取自 AFM。 */
const TIMES_ROMAN = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541]
const TIMES_BOLD = [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520]
const EXTRA: Record<number, [number, number]> = { 0xb7: [250, 250], 0x2013: [500, 500], 0x2014: [1000, 1000], 0x2026: [1000, 1000], 0x2022: [350, 350], 0x2018: [333, 333], 0x2019: [333, 333], 0x201c: [444, 500], 0x201d: [444, 500], 0xb0: [400, 400], 0xd7: [564, 570], 0xb1: [564, 570], 0xa5: [500, 500], 0xa0: [250, 250] }

export const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/
/** 不能出现在行首的标点 */
const NO_LINE_START = new Set('，。、；：！？）】》」』”’…,.;:!?)]}%'.split(''))
/** 不能出现在行尾的标点 */
const NO_LINE_END = new Set('（【《「『“‘([{'.split(''))

/** 单个字符宽度（1/1000 em）。CJK 按 1em；未知字符保守按 1em。 */
export function charWidthEm(ch: string, bold = false): number {
  const cp = ch.codePointAt(0)!
  if (cp >= 32 && cp <= 126) return (bold ? TIMES_BOLD : TIMES_ROMAN)[cp - 32]
  if (cp === 0x3000) return 1000
  if (cp >= 0xff61 && cp <= 0xffdc) return 500 // 半角片假名等
  if (CJK_RE.test(ch)) return 1000
  const e = EXTRA[cp]; if (e) return bold ? e[1] : e[0]
  if (cp < 0x80) return 0
  return 1000
}

/** 文本宽度（pt）。 */
export function measureText(text: string, fontSize: number, bold = false): number {
  let w = 0
  for (const ch of text) w += charWidthEm(ch, bold)
  return (w * fontSize) / 1000
}

interface Token { text: string; width: number; kind: 'cjk' | 'word' | 'space' }

function tokenize(text: string, fontSize: number, bold: boolean): Token[] {
  const out: Token[] = []
  let word = ''
  const flush = () => { if (word) { out.push({ text: word, width: measureText(word, fontSize, bold), kind: 'word' }); word = '' } }
  for (const ch of text) {
    if (ch === ' ') { flush(); out.push({ text: ' ', width: measureText(' ', fontSize, bold), kind: 'space' }) }
    else if (CJK_RE.test(ch) || charWidthEm(ch, bold) >= 1000 && ch.codePointAt(0)! > 0x2000) { flush(); out.push({ text: ch, width: measureText(ch, fontSize, bold), kind: 'cjk' }) }
    else word += ch
  }
  flush()
  return out
}

/**
 * 把一段文本按最大宽度切成多行。规则：
 * - CJK 字符逐字可断；西文单词不拆（超过整行宽度的单词才强制拆）
 * - 行首不出现 NO_LINE_START 标点、行尾不出现 NO_LINE_END 标点（简版禁则）
 * - 原有的 '\n' 视为硬换行；行首行尾空格去掉
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, opts: { bold?: boolean; safety?: number } = {}): string[] {
  const bold = opts.bold ?? false
  const limit = maxWidth * (1 - (opts.safety ?? 0.015))
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const tokens = tokenize(para, fontSize, bold)
    let line: Token[] = []; let width = 0
    const commit = () => { const s = line.map(t => t.text).join('').trim(); lines.push(s); line = []; width = 0 }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.kind === 'word' && t.width > limit) {
        // 超长西文单词：逐字符硬拆
        for (const ch of t.text) {
          const w = measureText(ch, fontSize, bold)
          if (width + w > limit && line.length) commit()
          line.push({ text: ch, width: w, kind: 'word' }); width += w
        }
        continue
      }
      if (width + t.width > limit && line.length) {
        if (t.kind === 'space') { commit(); continue }
        // 禁则：当前字符不能做行首 → 把上一字符一起带下去
        if (t.kind === 'cjk' && NO_LINE_START.has(t.text) && line.length >= 2) {
          const prev = line.pop()!; width -= prev.width; commit(); line.push(prev); width += prev.width
        } else if (line.length && NO_LINE_END.has(line[line.length - 1].text) && line.length >= 2) {
          const prev = line.pop()!; width -= prev.width; commit(); line.push(prev); width += prev.width
        } else commit()
      }
      if (t.kind === 'space' && line.length === 0) continue
      line.push(t); width += t.width
    }
    commit()
  }
  return lines.length ? lines : ['']
}

/** 把若干片段用分隔符拼成尽量少的行（联系方式行用）。 */
export function packSegments(segments: string[], sep: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const seg of segments.filter(Boolean)) {
    const next = cur ? cur + sep + seg : seg
    if (cur && measureText(next, fontSize) > maxWidth) { lines.push(cur); cur = seg } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

/** ClassicCN 模板的版面常量（pt）。 */
export const A4 = { width: 595.28, height: 841.89 }
const mm = (v: number) => (v * 72) / 25.4
export const CLASSIC_CN = {
  fontSize: 10,
  lineHeight: 1.42,
  marginTop: mm(9), marginBottom: mm(8), marginX: mm(7.5),
  contentWidth: A4.width - 2 * mm(7.5),
  headerSide: mm(40),
  bulletIndent: 10,
  sectionGap: mm(2.6), entryGap: mm(1.7),
}
