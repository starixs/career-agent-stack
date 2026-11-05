import { extractJson } from '@career/core'
import { capturePngBase64, toLlmImage } from '../capture.js'
import { humanDrag } from '../human-input.js'
import { estimateRotationFromImage } from '../image-analysis.js'
import { waitForVerification } from '../verification.js'
import type { SolveResult, SolverDeps } from '../types.js'

/** 旋转验证码：图像环带估计优先，视觉估角兜底；拖动后必须重新核验。 */
const PROBE_EXPR = `(() => {
  const handle = document.querySelector('.geetest_slider_button,[class*="yidun_slider"],.slider_handler,.slider-button,[class*="slider"] [class*="btn"],[class*="slider"] [class*="icon"]');
  const track = document.querySelector('.geetest_slider_track,[class*="yidun_slider"][class*="container"],.slider-track,[class*="slider"][class*="track"]');
  const region = document.querySelector('iframe[src*="captcha"],.geetest_box,[class*="yidun_panel"],[class*="captcha"][class*="panel"],[class*="verify"][class*="panel"]');
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { handle: rect(handle), track: rect(track), region: rect(region) };
})()`

async function passed(deps: SolverDeps): Promise<boolean> {
  return deps.page.evalJson<boolean>(`(() => {
    if (document.querySelector('.geetest_success,[class*="yidun"][class*="success"],[class*="verify"][class*="success"]')) return true;
    return !/使图片为正|旋转|摆正|rotate|请完成验证/i.test(document.body.innerText || '');
  })()`)
}

async function angleFromVision(deps: SolverDeps, shot: string): Promise<number | null> {
  const res = await deps.llm.complete({ json: true, maxTokens: 160, messages: [{ role: 'user', content: '这是旋转拼图验证码。估计图片还需要顺时针旋转多少度（0–360）。只回 JSON：{"angle":度数,"confidence":0到1}', images: [toLlmImage(shot)] }] })
  const answer = extractJson<{ angle: number; confidence?: number }>(res.text)
  if (!Number.isFinite(answer.angle) || answer.angle < 0 || answer.angle > 360 || (answer.confidence ?? 1) < 0.5) return null
  return answer.angle
}

export async function solveRotation(deps: SolverDeps): Promise<SolveResult> {
  const cdp = deps.page.cdp()
  if (!cdp) return { outcome: 'needs_cdp', detail: '旋转验证需要可信 CDP 拖动', attempts: 0 }
  const probe = await deps.page.evalJson<{ handle: { x: number; y: number; width: number; height: number } | null; track: { x: number; width: number } | null; region: { x: number; y: number; width: number; height: number } | null } | null>(PROBE_EXPR)
  if (!probe?.handle || !probe.region) return { outcome: 'failed', detail: '找不到旋转图片或滑块把手', attempts: 0 }
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const rand = deps.rand ?? Math.random
  const maxAttempts = deps.maxAttempts ?? 2
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let angle: number | null = null
    const shot = await capturePngBase64(deps.page, probe.region)
    try {
      const hit = await estimateRotationFromImage(Uint8Array.from(atob(shot), ch => ch.charCodeAt(0)))
      angle = hit?.angle ?? null
    } catch { /* 图像不可用时走视觉估角 */ }
    if (angle === null) {
      try { angle = await angleFromVision(deps, shot) } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
    }
    if (angle === null) return { outcome: 'failed', detail: lastError || '旋转角度不可信，交给人工', attempts: attempt - 1 }
    const signed = angle > 180 ? angle - 360 : angle
    const travel = Math.max(40, (probe.track?.width ?? probe.region.width) - probe.handle.width)
    const distance = signed / 360 * travel
    if (Math.abs(distance) < 4) return { outcome: 'failed', detail: '旋转距离过小，没有拖动', attempts: attempt - 1 }
    const from = { x: probe.handle.x + probe.handle.width / 2, y: probe.handle.y + probe.handle.height / 2 }
    await humanDrag({ cdp, rand, sleep }, from, distance)
    if (await waitForVerification(() => passed(deps), sleep, 1400)) return { outcome: 'passed', detail: `旋转 ${Math.round(angle)}° 后通过`, attempts: attempt }
    lastError = `旋转 ${Math.round(angle)}° 未通过`
  }
  return { outcome: 'failed', detail: lastError, attempts: maxAttempts }
}
