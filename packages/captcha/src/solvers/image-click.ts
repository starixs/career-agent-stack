import { extractJson } from '@career/core'
import { capturePngBase64, toLlmImage } from '../capture.js'
import { humanClick } from '../human-input.js'
import type { SolveResult, SolverDeps } from '../types.js'

/**
 * 图点选求解（点选文字 / 图选类别 / hCaptcha 网格）：
 * 截验证码容器 → 视觉模型给目标 → 可信点击逐个点 → 核验。
 *
 * 坐标策略（吸收产品里 captcha-solver 的实测经验）：**视觉模型报编号不报像素**——
 * 把容器划成约 40px 的网格让模型报格子号，代码换算成中心坐标；
 * 容器太小（格子 < 2×2）才退回 0–1000 归一化坐标。
 */

/** 网格边长（CSS 像素）：点选的字一般 30–40px，格子比字小一点才点得准。 */
export const CLICK_GRID_CELL_PX = 40

interface Grid { cols: number; rows: number }

const gridOf = (w: number, h: number): Grid => ({
  cols: Math.max(2, Math.round(w / CLICK_GRID_CELL_PX)),
  rows: Math.max(2, Math.round(h / CLICK_GRID_CELL_PX)),
})

interface VisionAnswer {
  /** 网格模式：按顺序要点的格子号（从 1 开始、按行编号）。 */
  cells?: number[]
  /** 归一化模式：按顺序要点的 0–1000 坐标。 */
  order?: Array<{ x: number; y: number }>
  confidence?: number
  note?: string
}

const MAX_CLICKS = 9

async function findContainer(deps: SolverDeps): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return deps.page.evalJson<{ x: number; y: number; width: number; height: number } | null>(`(() => {
    const pick = document.querySelector(
      '.geetest_item_wrap,[class*="yidun"][class*="bgimg"],.tcaptcha_bg,[class*="tcaptcha"] [class*="bg"],' +
      'iframe[src*="hcaptcha"],.h-captcha,[class*="captcha"][class*="image"],[class*="captcha"][class*="content"]'
    );
    if (!pick) return null;
    const r = pick.getBoundingClientRect();
    return r.width < 30 || r.height < 30 ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`)
}

async function verifyPassed(deps: SolverDeps): Promise<boolean> {
  return deps.page.evalJson<boolean>(`(() => {
    if (document.querySelector('.geetest_success,[class*="yidun"][class*="success"],[class*="captcha"][class*="success"]')) return true;
    const t = (document.body.innerText || '').slice(0, 2000);
    return !/按顺序点击|依次点击|点击图中|请点击.*(文字|图片)|select all images/i.test(t);
  })()`)
}

/** 把模型的答案换算成容器内的视口坐标点。 */
export function targetsFromAnswer(
  answer: VisionAnswer,
  grid: Grid,
  container: { x: number; y: number; width: number; height: number },
): Array<{ x: number; y: number }> | null {
  const cw = container.width / grid.cols
  const ch = container.height / grid.rows
  const points: Array<{ x: number; y: number }> = []
  if (Array.isArray(answer.cells) && answer.cells.length > 0) {
    for (const n of answer.cells) {
      if (!Number.isInteger(n) || n < 1 || n > grid.cols * grid.rows) return null
      const col = (n - 1) % grid.cols
      const row = Math.floor((n - 1) / grid.cols)
      points.push({ x: container.x + cw * (col + 0.5), y: container.y + ch * (row + 0.5) })
    }
    return points
  }
  if (Array.isArray(answer.order) && answer.order.length > 0) {
    for (const t of answer.order) {
      if (typeof t?.x !== 'number' || typeof t?.y !== 'number') return null
      points.push({
        x: container.x + (Math.max(0, Math.min(1000, t.x)) / 1000) * container.width,
        y: container.y + (Math.max(0, Math.min(1000, t.y)) / 1000) * container.height,
      })
    }
    return points
  }
  return null
}

export async function solveImageClick(deps: SolverDeps): Promise<SolveResult> {
  const cdp = deps.page.cdp()
  if (!cdp) return { outcome: 'needs_cdp', detail: '没有 CDP 会话，点选需要可信点击事件', attempts: 0 }
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const rand = deps.rand ?? Math.random
  const maxAttempts = deps.maxAttempts ?? 2

  const container = await findContainer(deps)
  if (!container) return { outcome: 'failed', detail: '找不到点选验证码容器', attempts: 0 }
  const grid = gridOf(container.width, container.height)

  let lastErr = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const shot = await capturePngBase64(deps.page, container)
    let answer: VisionAnswer
    const useGrid = grid.cols >= 2 && grid.rows >= 2 && grid.cols * grid.rows <= 144
    try {
      const prompt = useGrid
        ? `这是点选/图选验证码的截图，图上被划分成 ${grid.cols} 列 × ${grid.rows} 行的网格（从左上角 1 开始按行编号）。请读出题目，按题目顺序给出需要点击的每个目标所在格子号。只回 JSON：{"cells": [格子号...], "confidence": <0到1>, "note": "<题目原文>"}`
        : '这是点选/图选验证码的截图。请读出题目，给出按题目顺序需要点击的目标中心坐标。坐标用 0–1000 归一化（左上为 0,0，右下为 1000,1000）。只回 JSON：{"order": [{"x": <0-1000>, "y": <0-1000>}], "confidence": <0到1>, "note": "<题目原文>"}'
      const res = await deps.llm.complete({
        json: true,
        maxTokens: 300,
        messages: [{ role: 'user', content: prompt, images: [toLlmImage(shot)] }],
      })
      answer = extractJson<VisionAnswer>(res.text)
    } catch (e) {
      return { outcome: 'failed', detail: `视觉识别失败: ${String(e)}`, attempts: attempt - 1 }
    }
    const targets = targetsFromAnswer(answer, grid, container)
    if (!targets || targets.length === 0 || targets.length > MAX_CLICKS) {
      return { outcome: 'failed', detail: `视觉返回的目标不对（${JSON.stringify(answer).slice(0, 80)}）`, attempts: attempt - 1 }
    }
    if ((answer.confidence ?? 1) < 0.5) { lastErr = `视觉置信度低（${answer.confidence}）`; continue }

    for (const p of targets) {
      await humanClick({ cdp, rand, sleep }, p.x, p.y)
      await sleep(320 + rand() * 380)
    }
    await sleep(900 + rand() * 700)
    if (await verifyPassed(deps)) {
      const how = useGrid ? `格子 ${JSON.stringify(answer.cells)}` : `${targets.length} 个归一化坐标`
      return { outcome: 'passed', detail: `按${how}点了 ${targets.length} 个目标后通过`, attempts: attempt }
    }
    lastErr = '点击序列未通过核验'
  }
  return { outcome: 'failed', detail: lastErr, attempts: maxAttempts }
}
