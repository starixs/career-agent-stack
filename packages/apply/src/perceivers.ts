import { extractJson, type LLM } from '@career/core'
import type { PageLike } from './page.js'
import { domBoxesScript } from './scripts.js'
import { normKey, BASIC_ALIASES } from './interpret.js'
import { el, type Perceiver, type Perception, type PerceiveContext, type UiElement, type UiKind } from './perception.js'

/**
 * 感知器实现（视觉层的"眼睛"），按成本从低到高：
 *  1. DomBoxPerceiver：DOM 能看到元素但填不进去 / 点不到时，用 getBoundingClientRect 给坐标（零成本）；
 *  2. OCR 感知器（壳里实现：macOS Vision / RapidOCR）：只认字，看不见输入框 → synthesizeInputsFromLabels 按标签位置推断；
 *  3. VlmPerceiver：视觉模型，只在前两者不够时用（给它 OCR 的编号文字做 Set-of-Mark，让它选编号而不是报坐标）。
 * composePerceivers 把多层结果合并去重。
 */

/** DOM 盒子感知：不需要截图，直接问页面要可见元素的包围盒。 */
export class DomBoxPerceiver implements Perceiver {
  readonly id = 'dom-boxes'
  constructor(private page: PageLike) {}
  async perceive(_shot: Uint8Array, ctx: PerceiveContext): Promise<Perception> {
    const t0 = Date.now()
    const boxes = await this.page.evaluate(domBoxesScript)
    const elements: UiElement[] = boxes.map((b, i) => ({ id: `dom:${i}`, kind: b.kind as UiKind, text: b.text, box: { x: b.x, y: b.y, w: b.w, h: b.h }, confidence: 1 }))
    return { source: this.id, viewport: ctx.viewport, elements, tookMs: Date.now() - t0 }
  }
}

/** 合并多个感知器：同类元素包围盒重叠 ≥ 60% 视为同一个，保留置信度高的。 */
export function composePerceivers(perceivers: Perceiver[], id = 'composed'): Perceiver {
  return {
    id,
    async perceive(shot, ctx) {
      const t0 = Date.now()
      const results = await Promise.all(perceivers.map(p => p.perceive(shot, ctx).catch(() => null)))
      const elements: UiElement[] = []
      for (const r of results) if (r) for (const e of r.elements) {
        const dup = elements.find(x => x.kind === e.kind && overlap(x, e) >= 0.6)
        if (!dup) elements.push(e)
        else if (e.confidence > dup.confidence || (!dup.text && e.text)) Object.assign(dup, { text: dup.text || e.text, confidence: Math.max(dup.confidence, e.confidence) })
      }
      return { source: results.filter(Boolean).map(r => r!.source).join('+') || id, viewport: ctx.viewport, elements, tookMs: Date.now() - t0 }
    },
  }
}

function overlap(a: UiElement, b: UiElement): number {
  const x1 = Math.max(a.box.x, b.box.x), y1 = Math.max(a.box.y, b.box.y)
  const x2 = Math.min(a.box.x + a.box.w, b.box.x + b.box.w), y2 = Math.min(a.box.y + a.box.h, b.box.y + b.box.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const smaller = Math.min(a.box.w * a.box.h, b.box.w * b.box.h) || 1
  return inter / smaller
}

const LABEL_WORDS = Object.values(BASIC_ALIASES).flat().map(normKey)
/** OCR 文本像不像表单标签：命中资料别名，或以冒号 / 星号结尾，或很短（≤ 8 字）且不像句子。 */
export function looksLikeFieldLabel(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 24) return false
  if (/[：:*＊]$/.test(t) || /^[*＊]/.test(t)) return true
  const n = normKey(t)
  if (LABEL_WORDS.some(w => w && (n === w || n.endsWith(w)))) return true
  return t.length <= 8 && !/[。！？!?，,]/.test(t)
}

/**
 * OCR 只给文字：给"像标签"的文字在右侧（同一行没有别的文字挡住）合成一个输入框，
 * 否则在正下方合成。置信度低，只作为没有 DOM 盒子时的兜底。
 */
export function synthesizeInputsFromLabels(p: Perception, opts: { inputWidth?: number; inputHeight?: number } = {}): Perception {
  const w = opts.inputWidth ?? 220, h = opts.inputHeight ?? 32
  const hasInputs = p.elements.some(e => e.kind === 'input' || e.kind === 'select')
  if (hasInputs) return p
  const texts = p.elements.filter(e => e.kind === 'text' && e.text)
  const extra: UiElement[] = []
  for (const t of texts) {
    if (!looksLikeFieldLabel(t.text)) continue
    const rightX = t.box.x + t.box.w + 12
    const rowBlocked = texts.some(o => o !== t && o.box.x >= rightX - 4 && o.box.x < rightX + w && Math.abs(o.box.y - t.box.y) < Math.max(t.box.h, o.box.h))
    if (!rowBlocked && rightX + w <= p.viewport.width + 40) extra.push(el('input', '', [rightX, t.box.y - Math.max(0, (h - t.box.h) / 2), w, h], 0.35, `syn:${t.id}:r`))
    else extra.push(el('input', '', [t.box.x, t.box.y + t.box.h + 8, Math.max(w, t.box.w), h], 0.3, `syn:${t.id}:b`))
  }
  return { ...p, elements: [...p.elements, ...extra] }
}

/**
 * 视觉模型感知：把截图 + OCR 文字编号表交给模型，让它只做"分类 + 选编号"：
 * 哪些编号是输入框 / 按钮 / 标签，以及截图里 OCR 没认出来的控件（给出包围盒）。
 */
export class VlmPerceiver implements Perceiver {
  readonly id = 'vlm'
  constructor(private llm: LLM, private base?: Perceiver, private opts: { mediaType?: 'image/jpeg' | 'image/png'; maxElements?: number } = {}) {}
  async perceive(shot: Uint8Array, ctx: PerceiveContext): Promise<Perception> {
    if (this.llm.supportsImages && !this.llm.supportsImages()) throw new Error('当前模型不支持图片输入，无法使用视觉模型感知')
    const t0 = Date.now()
    const base = this.base ? await this.base.perceive(shot, ctx).catch(() => null) : null
    const marks = (base?.elements ?? []).slice(0, this.opts.maxElements ?? 120).map((e, i) => ({ n: i + 1, kind: e.kind, text: e.text, box: e.box }))
    const system = `你在看一张网页截图（视口 ${ctx.viewport.width}x${ctx.viewport.height} CSS 像素）。任务：识别网申表单里的控件。
规则：
1. 下面给了已识别的元素编号表（可能只有文字）。请判断每个编号属于 input / select / checkbox / radio / button / link / text 之一。
2. 截图里有、编号表里没有的输入框或按钮，请补充，给出包围盒 {x,y,w,h}（视口像素）与可见文字（输入框给 placeholder 或空串）。
3. 不要编造；看不清的不要给。只输出 JSON：{"elements":[{"n":1,"kind":"input"},{"kind":"button","text":"下一步","box":{"x":0,"y":0,"w":0,"h":0}}]}`
    const user = `${ctx.hint ? `当前目标：${ctx.hint}\n` : ''}编号表：\n${JSON.stringify(marks)}`
    const res = await this.llm.complete({ system, messages: [{ role: 'user', content: user, images: [{ mediaType: this.opts.mediaType ?? 'image/jpeg', data: Buffer.from(shot).toString('base64') }] }], json: true, temperature: 0 })
    const parsed = extractJson<{ elements?: Array<{ n?: number; kind?: UiKind; text?: string; box?: { x: number; y: number; w: number; h: number } }> }>(res.text)
    const elements: UiElement[] = base ? base.elements.map(e => ({ ...e })) : []
    for (const item of parsed.elements ?? []) {
      if (item.n && marks[item.n - 1]) { const e = elements[item.n - 1]; if (e && item.kind) { e.kind = item.kind; e.confidence = Math.max(e.confidence, 0.7) } continue }
      if (item.box && item.kind && item.box.w > 0 && item.box.h > 0) elements.push({ id: `vlm:${elements.length}`, kind: item.kind, text: item.text ?? '', box: item.box, confidence: 0.6 })
    }
    return { source: base ? `${base.source}+vlm` : 'vlm', viewport: ctx.viewport, elements, tookMs: Date.now() - t0 }
  }
}
