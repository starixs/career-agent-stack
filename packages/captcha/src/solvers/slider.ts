import { extractJson } from '@career/core'
import { capturePngBase64, toLlmImage } from '../capture.js'
import { humanDrag } from '../human-input.js'
import type { SolveResult, SolverDeps } from '../types.js'

/**
 * 滑块求解：找把手 → 估距离 → 人类轨迹拖动 → 核验 → 失败校正重试。
 * 距离估计两途径：视觉模型读截图（首选，覆盖极验 / 易盾 / 防水墙 / 自研滑块）；
 * 无视觉或低置信度则放弃（宁给人工，不瞎拖——乱拖会触发风控升级）。
 */

/** 纯函数：按列异常分估计缺口位置。cols 是背景图每列的活跃度（越高越异常）。 */
export function estimateGapFromColumns(cols: readonly number[]): { index: number; confidence: number } | null {
  if (cols.length < 10) return null
  const mean = cols.reduce((a, b) => a + b, 0) / cols.length
  const std = Math.sqrt(cols.reduce((a, b) => a + (b - mean) * (b - mean), 0) / cols.length) || 1
  // 找“陡升 → 高原 → 陡降”的缺口形状，比单点峰值更抗噪
  let best = -1, bestScore = 0
  for (let i = 2; i < cols.length - 2; i++) {
    const z = (cols[i] - mean) / std
    if (z < 1.2) continue
    const rise = cols[i] - cols[i - 2]
    const fall = cols[i] - cols[i + 2]
    const score = z + Math.min(rise, fall) / std / 2
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0) return null
  return { index: best, confidence: Math.min(1, bestScore / 6) }
}

interface SliderProbe {
  handle: { x: number; y: number; width: number; height: number } | null
  track: { x: number; y: number; width: number; height: number } | null
  /** 厂商成功标志元素存在（拖完核验用）。 */
  successSelector: string | null
}

const PROBE_EXPR = `(() => {
  const handle = document.querySelector(
    '.geetest_slider_button,[class*="yidun_slider"],.nc_iconfont,.btn_slide,.slider-btn,' +
    '.slider_handler,.slider-button,[class*="slider"][class*="handler"],#aliyunCaptcha-sliding,' +
    '[class*="slide"][class*="verify"] [class*="btn"],[class*="slider"] [class*="icon"]'
  );
  const track = document.querySelector(
    '.geetest_slider_track,[class*="yidun_slider"][class*="container"],.nc_container,.slider-track,' +
    '[class*="slider"][class*="track"],[class*="slide"][class*="container"]'
  );
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const success = document.querySelector(
    '.geetest_success,[class*="yidun"][class*="success"],[class*="slider"][class*="success"],' +
    '.geetest_slider .geetest_success_btn,[class*="verify"][class*="success"]'
  );
  return { handle: handle ? rect(handle) : null, track: track ? rect(track) : null, hasSuccess: !!success };
})()`

async function probeSlider(deps: SolverDeps): Promise<SliderProbe | null> {
  const raw = await deps.page.evalJson<{ handle: SliderProbe['handle']; track: SliderProbe['track']; hasSuccess: boolean } | null>(PROBE_EXPR)
  if (!raw || !raw.handle) return null
  return { handle: raw.handle, track: raw.track, successSelector: raw.hasSuccess ? '[class*="success"]' : null }
}

/** 拖完的核验：成功标志出现，或页面验证码痕迹消失。 */
async function verifyPassed(deps: SolverDeps): Promise<boolean> {
  return deps.page.evalJson<boolean>(`(() => {
    if (document.querySelector('.geetest_success,[class*="yidun"][class*="success"],[class*="slider"][class*="success"],[class*="verify"][class*="success"]')) return true;
    const t = (document.body.innerText || '').slice(0, 2000);
    return !/拖动滑块|滑动验证|请完成验证|按顺序点击|图形验证码/.test(t);
  })()`)
}

/** 视觉估距：截轨道区域，问模型缺口离轨道左端多少像素。 */
async function distanceFromVision(deps: SolverDeps, track: { x: number; y: number; width: number; height: number }): Promise<number | null> {
  const shot = await capturePngBase64(deps.page, track)
  const res = await deps.llm.complete({
    json: true,
    maxTokens: 200,
    messages: [{
      role: 'user',
      content: '这是滑块验证码的轨道区域截图（宽 ' + Math.round(track.width) + ' CSS 像素）。缺口（拼图洞）中心距离轨道左端的水平像素距离是多少？只回 JSON：{"distance": <数字>, "confidence": <0到1>}',
      images: [toLlmImage(shot)],
    }],
  })
  const parsed = extractJson<{ distance: number; confidence?: number }>(res.text)
  if (typeof parsed.distance !== 'number' || parsed.distance <= 0 || parsed.distance > track.width) return null
  if ((parsed.confidence ?? 1) < 0.5) return null
  return parsed.distance
}

export async function solveSlider(deps: SolverDeps): Promise<SolveResult> {
  const cdp = deps.page.cdp()
  if (!cdp) return { outcome: 'needs_cdp', detail: '没有 CDP 会话，滑块需要可信拖动事件', attempts: 0 }
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const rand = deps.rand ?? Math.random
  const maxAttempts = deps.maxAttempts ?? 2

  const probe = await probeSlider(deps)
  if (!probe?.handle) return { outcome: 'failed', detail: '页面上找不到滑块把手', attempts: 0 }

  let lastErr = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 轨道探不到时用常见滑块轨道宽度兜底（视觉模型以截图为准，这里只定截图范围）
    const track = probe.track ?? { x: probe.handle.x, y: probe.handle.y - 20, width: 280, height: probe.handle.height + 40 }
    let distance: number | null = null
    try { distance = await distanceFromVision(deps, track) } catch (e) { lastErr = `视觉估距失败: ${String(e)}` }
    if (distance == null) return { outcome: 'failed', detail: lastErr || '视觉估距不可用或置信度低，留给人工', attempts: attempt - 1 }

    const from = { x: probe.handle.x + probe.handle.width / 2, y: probe.handle.y + probe.handle.height / 2 }
    // 第 2 轮起带随机校正（第 1 轮失败常见原因是缺口判定偏移）
    const adjust = attempt === 1 ? 0 : (rand() - 0.5) * 24
    await humanDrag({ cdp, rand, sleep }, from, Math.max(6, distance + adjust))
    await sleep(900 + rand() * 600)
    if (await verifyPassed(deps)) return { outcome: 'passed', detail: `拖动 ${Math.round(distance + adjust)}px 后通过`, attempts: attempt }
    lastErr = `拖动 ${Math.round(distance)}px 未通过`
  }
  return { outcome: 'failed', detail: lastErr, attempts: maxAttempts }
}
