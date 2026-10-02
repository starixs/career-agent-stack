import type { PageLike } from './page.js'
import { scrollByScript } from './scripts.js'
import { humanDelay, type PacingOptions } from './pacing.js'
import { center, locateInputForLabel, locateButton, type Perceiver, type Perception, type UiElement } from './perception.js'

/**
 * 视觉兜底层（L2）的原子动作：截图 → 感知 → 坐标点击 / 键盘输入。
 * 全部确定性：Perceiver 只回答"哪里有什么"，点哪里、填什么由这里按规则决定。
 * 永远不点提交类按钮（guard 由调用方传入，复用 isSubmitText）。
 */
export interface VisionOptions extends PacingOptions {
  perceiver: Perceiver
  /** 找不到目标时最多向下滚几屏再找。 */
  maxScrolls?: number
  scrollPx?: number
  /** 每次动作后的停顿区间（毫秒）。测试给 [0,0]。 */
  pause?: [number, number]
  /** 键入字符间隔（毫秒）。 */
  typeDelayMs?: number
  log?: (msg: string) => void
}
export interface VisionFillResult { ok: boolean; via?: 'right' | 'below' | 'label'; evidence: string; perception?: Perception }
export interface VisionClickResult { clicked: UiElement | null; refused?: string; evidence: string }

async function viewport(page: PageLike): Promise<{ width: number; height: number }> {
  return (await page.viewportSize?.()) ?? { width: 1280, height: 800 }
}

/** 截图 + 感知。 */
export async function visionScan(page: PageLike, opts: VisionOptions, hint?: string): Promise<Perception> {
  const shot = await page.screenshot()
  const vp = await viewport(page)
  const t0 = Date.now()
  const p = await opts.perceiver.perceive(shot, { viewport: vp, url: page.url(), hint })
  return { ...p, tookMs: p.tookMs ?? Date.now() - t0 }
}

/** 在当前屏找，找不到就向下滚再找；返回命中帧的感知结果。 */
export async function visionFind<T>(page: PageLike, opts: VisionOptions, find: (p: Perception) => T | null, hint?: string): Promise<{ hit: T; perception: Perception } | null> {
  const maxScrolls = opts.maxScrolls ?? 4
  for (let i = 0; i <= maxScrolls; i++) {
    const perception = await visionScan(page, opts, hint)
    const hit = find(perception)
    if (hit) return { hit, perception }
    if (i === maxScrolls) break
    const vp = await viewport(page)
    const moved = await page.evaluate(scrollByScript, opts.scrollPx ?? Math.round(vp.height * 0.7))
    await humanDelay(opts.pause?.[0] ?? 200, opts.pause?.[1] ?? 500, opts)
    if (typeof moved === 'number' && i > 0 && moved === 0) break
  }
  return null
}

/** 点进输入框、全选清空、逐字键入。 */
export async function visionFill(page: PageLike, opts: VisionOptions, label: string, value: string): Promise<VisionFillResult> {
  if (!page.mouse || !page.keyboard) return { ok: false, evidence: '页面实现不支持坐标点击 / 键盘输入' }
  const found = await visionFind(page, opts, p => locateInputForLabel(p, label), `寻找表单字段「${label}」`)
  if (!found) return { ok: false, evidence: `截图里没找到「${label}」` }
  const { hit, perception } = found
  const c = center(hit.target.box)
  opts.log?.(`视觉层：点击「${label}」(${hit.via}) @${c.x},${c.y}`)
  await page.mouse.move?.(c.x, c.y)
  await page.mouse.click(c.x, c.y)
  await humanDelay(opts.pause?.[0] ?? 80, opts.pause?.[1] ?? 200, opts)
  if (hit.target.kind === 'checkbox' || hit.target.kind === 'radio') return { ok: true, via: hit.via, evidence: `已点击 ${hit.target.kind}`, perception }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  for (const ch of Array.from(value)) {
    await page.keyboard.type(ch)
    if (opts.typeDelayMs !== 0) await humanDelay(opts.typeDelayMs ?? 40, (opts.typeDelayMs ?? 40) * 3, opts)
  }
  if (hit.target.kind === 'select') { await humanDelay(opts.pause?.[0] ?? 200, opts.pause?.[1] ?? 500, opts); await page.keyboard.press('Enter') }
  return { ok: true, via: hit.via, evidence: `视觉层键入 ${value.length} 字`, perception }
}

/** 按文案找按钮并点击；guard 返回 true 的文案（提交类）一律拒绝。 */
export async function visionClickText(page: PageLike, opts: VisionOptions, texts: readonly string[], guard: (text: string) => boolean): Promise<VisionClickResult> {
  if (!page.mouse) return { clicked: null, evidence: '页面实现不支持坐标点击' }
  const found = await visionFind(page, opts, p => locateButton(p, texts), `寻找按钮 ${texts.join(' / ')}`)
  if (!found) return { clicked: null, evidence: `截图里没找到按钮：${texts.join(' / ')}` }
  const btn = found.hit
  if (guard(btn.text)) return { clicked: null, refused: btn.text, evidence: `拒绝点击提交类按钮「${btn.text}」` }
  const c = center(btn.box)
  opts.log?.(`视觉层：点击按钮「${btn.text}」@${c.x},${c.y}`)
  await page.mouse.move?.(c.x, c.y)
  await page.mouse.click(c.x, c.y)
  return { clicked: btn, evidence: `已点击「${btn.text}」` }
}

/** 只找不点：有没有提交类按钮（给"停在提交前"用）。 */
export async function visionFindButton(page: PageLike, opts: VisionOptions, texts: readonly string[]): Promise<UiElement | null> {
  const found = await visionFind(page, { ...opts, maxScrolls: Math.min(opts.maxScrolls ?? 4, 2) }, p => locateButton(p, texts), `寻找按钮 ${texts.join(' / ')}`)
  return found?.hit ?? null
}
