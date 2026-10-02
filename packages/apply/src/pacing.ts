import type { PageLike } from './page.js'
import { scrollByScript } from './scripts.js'

/** 拟人节奏工具。所有随机源与睡眠都可注入，便于测试。 */
export interface PacingOptions { rng?: () => number; sleep?: (ms: number) => Promise<void> }

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function randomBetween(min: number, max: number, rng: () => number = Math.random): number {
  const lo = Math.min(min, max), hi = Math.max(min, max)
  return Math.floor(lo + rng() * (hi - lo + 1))
}

export async function humanDelay(minMs: number, maxMs: number, opts: PacingOptions = {}): Promise<number> {
  const ms = randomBetween(minMs, maxMs, opts.rng)
  await (opts.sleep ?? realSleep)(ms)
  return ms
}

/** 逐字输入，带随机间隔；偶尔停顿一下（像在想）。没有 keyboard 的 PageLike 退化为 fill。 */
export async function typeLikeHuman(page: PageLike, selector: string, text: string, opts: PacingOptions & { minMs?: number; maxMs?: number; pauseEvery?: number } = {}): Promise<void> {
  const { minMs = 40, maxMs = 160, pauseEvery = 12 } = opts
  if (!page.keyboard) { await page.fill(selector, text); return }
  await page.locator(selector).click()
  await page.fill(selector, '')
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    await page.keyboard.type(chars[i])
    await humanDelay(minMs, maxMs, opts)
    if (pauseEvery && (i + 1) % pauseEvery === 0) await humanDelay(minMs * 4, maxMs * 4, opts)
  }
}

/** 分几次往下滚，每次停一会；最后小幅回滚一下。 */
export async function scrollLikeHuman(page: PageLike, opts: PacingOptions & { steps?: number; stepPx?: [number, number]; pauseMs?: [number, number] } = {}): Promise<void> {
  const steps = opts.steps ?? randomBetween(2, 5, opts.rng)
  const [lo, hi] = opts.stepPx ?? [240, 720]
  const [pl, ph] = opts.pauseMs ?? [250, 900]
  for (let i = 0; i < steps; i++) {
    await page.evaluate(scrollByScript, randomBetween(lo, hi, opts.rng))
    await humanDelay(pl, ph, opts)
  }
  await page.evaluate(scrollByScript, -randomBetween(60, 180, opts.rng))
}
