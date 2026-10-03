import { normKey, fuzzyEquals } from './text.js'
export { editDistance, fuzzyEquals } from './text.js'

/**
 * 视觉感知层（L2 兜底）的数据契约。
 *
 * 分层执行：L1 = DOM 直驱（extractFields + fill/click）；DOM 拿不到字段 / 填不进去 / 找不到按钮时，
 * 降级到 L2 = 截图 → Perceiver（OCR / 视觉模型）→ 带坐标的元素 → 鼠标点击 + 键盘输入。
 * Perceiver 只负责"看"：输入截图，输出元素与包围盒；决策仍是确定性代码（不是让模型自由操作浏览器）。
 */
export interface UiBox { x: number; y: number; w: number; h: number }
export type UiKind = 'text' | 'input' | 'button' | 'checkbox' | 'radio' | 'select' | 'link' | 'icon' | 'unknown'
export interface UiElement {
  id: string
  kind: UiKind
  /** 可见文字（OCR 识别文本 / 按钮文案 / 输入框 placeholder）。 */
  text: string
  /** 视口 CSS 像素坐标（与 page.mouse.click 一致）。 */
  box: UiBox
  confidence: number
}
export interface Perception {
  source: string
  viewport: { width: number; height: number }
  elements: UiElement[]
  /** 感知耗时（毫秒），用于计量。 */
  tookMs?: number
}
export interface PerceiveContext { viewport: { width: number; height: number }; url?: string; hint?: string }
export interface Perceiver {
  id: string
  perceive(screenshot: Uint8Array, ctx: PerceiveContext): Promise<Perception>
}

export const center = (b: UiBox) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) })
const INPUT_KINDS: readonly UiKind[] = ['input', 'select', 'checkbox', 'radio']
const isInputKind = (k: UiKind) => INPUT_KINDS.includes(k)

/** 文本匹配：归一化后包含即命中；exact 时相等或模糊相等（OCR 容错）；长度最接近的优先。 */
export function findTextElements(p: Perception, needle: string, opts: { kinds?: readonly UiKind[]; exact?: boolean } = {}): UiElement[] {
  const n = normKey(needle)
  if (!n) return []
  return p.elements
    .filter(e => (!opts.kinds || opts.kinds.includes(e.kind)) && e.text)
    .filter(e => { const t = normKey(e.text); return opts.exact ? (t === n || fuzzyEquals(t, n)) : (t === n || t.includes(n) || (n.length >= 2 && n.includes(t) && t.length >= 2) || fuzzyEquals(t, n)) })
    .sort((a, b) => Math.abs(normKey(a.text).length - n.length) - Math.abs(normKey(b.text).length - n.length) || b.confidence - a.confidence)
}

/**
 * 标签 → 输入框：在标签右侧（同一行）或正下方找最近的输入类元素；都没有就退回标签本身
 * （很多表单点击标签即可聚焦输入框）。返回 null 表示标签都没找到。
 */
export function locateInputForLabel(p: Perception, label: string): { label: UiElement; target: UiElement; via: 'right' | 'below' | 'label' } | null {
  const labels = findTextElements(p, label).filter(e => !isInputKind(e.kind) || e.kind === 'unknown')
  const lab = labels[0] ?? findTextElements(p, label)[0]
  if (!lab) return null
  const lc = center(lab.box)
  const inputs = p.elements.filter(e => isInputKind(e.kind) && e !== lab)
  const right = inputs
    .filter(e => e.box.x >= lab.box.x + lab.box.w * 0.5 && Math.abs(center(e.box).y - lc.y) <= Math.max(lab.box.h, e.box.h))
    .sort((a, b) => a.box.x - b.box.x)[0]
  if (right) return { label: lab, target: right, via: 'right' }
  const below = inputs
    .filter(e => e.box.y >= lab.box.y + lab.box.h * 0.5 && e.box.y - (lab.box.y + lab.box.h) <= Math.max(80, lab.box.h * 3) && Math.abs(e.box.x - lab.box.x) <= Math.max(160, lab.box.w))
    .sort((a, b) => a.box.y - b.box.y)[0]
  if (below) return { label: lab, target: below, via: 'below' }
  return { label: lab, target: lab, via: 'label' }
}

/** 找按钮：优先 kind=button/link，退回任意带该文字的元素。 */
export function locateButton(p: Perception, texts: readonly string[]): UiElement | null {
  for (const t of texts) {
    const hit = findTextElements(p, t, { kinds: ['button', 'link'] })[0] ?? findTextElements(p, t, { exact: true })[0]
    if (hit) return hit
  }
  return null
}

/** 视觉上像不像一张表单：至少两个输入类元素。 */
export function looksLikeFormVisually(p: Perception): boolean {
  return p.elements.filter(e => isInputKind(e.kind)).length >= 2
}

/** 把感知结果里"标签 + 输入框"配成伪字段（给 interpretForm 复用同一套填写规划）。 */
export interface VisualField { id: string; label: string; element: UiElement; labelElement: UiElement; kind: UiKind }
export function pairVisualFields(p: Perception): VisualField[] {
  const inputs = p.elements.filter(e => isInputKind(e.kind))
  const texts = p.elements.filter(e => !isInputKind(e.kind) && e.text && e.kind !== 'button')
  const out: VisualField[] = []
  const used = new Set<string>()
  for (const inp of inputs) {
    const ic = center(inp.box)
    // 左侧同一行，或正上方最近的文本
    const left = texts.filter(t => !used.has(t.id) && t.box.x + t.box.w <= inp.box.x + 8 && Math.abs(center(t.box).y - ic.y) <= Math.max(inp.box.h, t.box.h)).sort((a, b) => (inp.box.x - (a.box.x + a.box.w)) - (inp.box.x - (b.box.x + b.box.w)))[0]
    const above = texts.filter(t => !used.has(t.id) && t.box.y + t.box.h <= inp.box.y + 4 && inp.box.y - (t.box.y + t.box.h) <= 60 && Math.abs(t.box.x - inp.box.x) <= Math.max(160, inp.box.w)).sort((a, b) => (inp.box.y - (a.box.y + a.box.h)) - (inp.box.y - (b.box.y + b.box.h)))[0]
    const lab = left ?? above
    const label = lab?.text || inp.text
    if (!label) continue
    if (lab) used.add(lab.id)
    out.push({ id: `v:${inp.id}`, label, element: inp, labelElement: lab ?? inp, kind: inp.kind })
  }
  return out
}

/** 测试 / 离线用：按预置的元素表回答。 */
export class FakePerceiver implements Perceiver {
  readonly id = 'fake'
  calls = 0
  private readonly frames: Perception[] | ((n: number, ctx: PerceiveContext) => Perception)
  constructor(frames: Perception | Perception[] | ((n: number, ctx: PerceiveContext) => Perception)) {
    this.frames = typeof frames === 'function' || Array.isArray(frames) ? frames : [frames]
  }
  async perceive(_shot: Uint8Array, ctx: PerceiveContext): Promise<Perception> {
    const n = this.calls++
    if (typeof this.frames === 'function') return this.frames(n, ctx)
    return this.frames[Math.min(n, this.frames.length - 1)]
  }
}

/** 组装 Perception 的小帮手（测试与 Perceiver 实现共用）。 */
export function el(kind: UiKind, text: string, box: [number, number, number, number], confidence = 0.9, id?: string): UiElement {
  return { id: id ?? `${kind}:${text}:${box[0]},${box[1]}`, kind, text, box: { x: box[0], y: box[1], w: box[2], h: box[3] }, confidence }
}
