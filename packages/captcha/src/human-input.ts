import type { CdpSessionLike } from './types.js'

/**
 * 人类化可信输入层：全部走 CDP `Input` 域，产出 isTrusted=true 的原生事件。
 * 技术来源（lsdefine/GenericAgent tmwd_cdp_bridge 的实测结论）：
 *  - 点击必须三事件序列 mouseMoved → mousePressed → mouseReleased（间隔 50–100ms）；
 *    省略 mouseMoved 会让 MUI Tooltip / AntD Dropdown 等 hover 依赖组件失效。
 *  - 首次 attach 后 Chrome 的“正在受自动化控制”infobar 会把页面推下 ~20px：
 *    先发一次无害 mouseMoved(0,0) 预热，之后坐标系才稳定。
 *  - 滑块拖动：初段快、末段慢、先过冲再回拉，全程带 ±1px 抖动。
 */

export interface HumanDeps {
  cdp: CdpSessionLike
  rand?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultRand = Math.random
const warmedSessions = new WeakSet<object>()

async function ensureWarmUp(d: HumanDeps): Promise<void> {
  if ((typeof d.cdp !== 'object' && typeof d.cdp !== 'function') || d.cdp === null) return
  const key = d.cdp as object
  if (warmedSessions.has(key)) return
  warmedSessions.add(key)
  await warmUpInput(d)
}

/** attach 后坐标系预热（无害移动一次，等 infobar 推挤完成）。 */
export async function warmUpInput(d: HumanDeps): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  await dispatchMouse(d.cdp, 'mouseMoved', 0, 0, {})
  await sleep(120)
}

interface MouseEventExtra { button?: string; buttons?: number; clickCount?: number }

async function dispatchMouse(cdp: CdpSessionLike, type: string, x: number, y: number, extra: MouseEventExtra): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    button: extra.button ?? (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: extra.buttons ?? (type === 'mouseMoved' ? 0 : 1),
    clickCount: extra.clickCount ?? 0,
  })
}

/** 三次贝塞尔曲线取样。p0/p3 为端点，p1/p2 控制点由调用方给出。 */
export function bezierPoints(
  p0: { x: number; y: number }, p3: { x: number; y: number },
  p1: { x: number; y: number }, p2: { x: number; y: number },
  steps: number,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t
    pts.push({
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
    })
  }
  return pts
}

/**
 * 人类鼠标移动：贝塞尔路径 + 中途点 ±1px 抖动，8–16 步，每步 8–25ms。
 * 终点单独加 ±1.5px 落点误差（落点由调用方修正后使用）。
 */
export async function humanMove(d: HumanDeps, to: { x: number; y: number }, from?: { x: number; y: number }): Promise<void> {
  const rand = d.rand ?? defaultRand
  const sleep = d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const start = from ?? { x: to.x - 20 - rand() * 60, y: to.y + (rand() - 0.5) * 40 }
  const steps = 8 + Math.floor(rand() * 9)
  const dx = to.x - start.x
  // 控制点：起终点之间随机拱起
  const p1 = { x: start.x + dx * (0.2 + rand() * 0.2), y: start.y + (rand() - 0.5) * 60 }
  const p2 = { x: start.x + dx * (0.6 + rand() * 0.2), y: to.y + (rand() - 0.5) * 30 }
  for (const pt of bezierPoints(start, to, p1, p2, steps)) {
    const jitter = (rand() - 0.5) * 2
    await dispatchMouse(d.cdp, 'mouseMoved', pt.x + jitter, pt.y + (rand() - 0.5) * 2, {})
    await sleep(8 + rand() * 17)
  }
}

/** 人类点击：移动 → 停顿 → 按下 → 停顿 → 松开。落点带 ±1.5px 误差。 */
export async function humanClick(d: HumanDeps, x: number, y: number, opts: { double?: boolean } = {}): Promise<void> {
  const rand = d.rand ?? defaultRand
  const sleep = d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  await ensureWarmUp(d)
  const tx = x + (rand() - 0.5) * 3
  const ty = y + (rand() - 0.5) * 3
  await humanMove(d, { x: tx, y: ty })
  await sleep(50 + rand() * 50)
  await dispatchMouse(d.cdp, 'mousePressed', tx, ty, { clickCount: opts.double ? 2 : 1 })
  await sleep(60 + rand() * 60)
  await dispatchMouse(d.cdp, 'mouseReleased', tx, ty, { clickCount: opts.double ? 2 : 1 })
}

/** 常用键的 VK 码（可打印字符用字符码）。 */
const VK: Record<string, number> = {
  Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
}
const vkOf = (ch: string): number => VK[ch] ?? ch.charCodeAt(0)

/** 人类键入：逐字符 keyDown/text → keyUp，随机间隔；偶尔误输入后删除重来。 */
export async function humanType(d: HumanDeps, text: string, target?: { focusFirst?: () => Promise<void> }): Promise<void> {
  const rand = d.rand ?? defaultRand
  const sleep = d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const stroke = async (ch: string, printable = true) => {
    const code = vkOf(ch)
    await d.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, ...(printable ? { text: ch } : {}), code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await sleep(20 + rand() * 30)
    await d.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  }
  if (target?.focusFirst) await target.focusFirst()
  for (const [index, ch] of [...text].entries()) {
    if (index > 0 && /^[A-Za-z0-9]$/.test(ch) && rand() < 0.05) {
      await stroke(ch === 'x' ? 'z' : 'x')
      await sleep(90 + rand() * 120)
      await stroke('Backspace', false)
      await sleep(60 + rand() * 100)
    }
    await stroke(ch)
    await sleep(40 + rand() * 100 + (rand() < 0.04 ? 180 + rand() * 270 : 0))
  }
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

/**
 * 人类拖动（滑块）：按下 → 沿缓动轨迹移动（先过冲 4–10px 再回拉）→ 松开。
 * 轨迹特征来自对真人滑块的常见刻画：初段快、末段慢、横向 ±1px 纵向 ±1px 抖动。
 */
export async function humanDrag(
  d: HumanDeps,
  from: { x: number; y: number },
  distance: number,
  opts: { durationMs?: number } = {},
): Promise<void> {
  const rand = d.rand ?? defaultRand
  const sleep = d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const duration = opts.durationMs ?? 700 + rand() * 500
  const steps = 26 + Math.floor(rand() * 14)

  await ensureWarmUp(d)
  await dispatchMouse(d.cdp, 'mousePressed', from.x, from.y, { clickCount: 1 })
  await sleep(100 + rand() * 100)

  const overshoot = (4 + rand() * 6) * Math.sign(distance || 1)
  const target = { x: from.x + distance, y: from.y }
  // 中途过冲点 → 最终目标；两段贝塞尔拼出“冲过头再修正”
  const via = { x: target.x + overshoot, y: from.y + (rand() - 0.5) * 3 }
  const leg1 = Math.floor(steps * 0.78)
  const leg2 = steps - leg1
  const p1 = { x: from.x + distance * 0.35, y: from.y + (rand() - 0.5) * 8 }
  const p2 = { x: from.x + distance * 0.85, y: from.y + (rand() - 0.5) * 8 }
  const all = [...bezierPoints(from, via, p1, p2, leg1), ...bezierPoints(via, target, { x: via.x, y: via.y }, { x: target.x - overshoot * 0.4, y: target.y }, leg2)]
  for (let i = 0; i < all.length; i++) {
    const pt = all[i]
    await dispatchMouse(d.cdp, 'mouseMoved', pt.x + (rand() - 0.5) * 2, pt.y + (rand() - 0.5) * 2, { buttons: 1 })
    // 缓动间隔：同样的步长下前快后慢
    const t = i / all.length
    await sleep((duration / all.length) * (1.6 - easeOutCubic(t)))
  }
  await sleep(80 + rand() * 80)
  await dispatchMouse(d.cdp, 'mouseReleased', target.x, target.y, { buttons: 0, clickCount: 1 })
}
