import { describe, it, expect } from 'vitest'
import { estimateGapFromColumns } from '../src/solvers/slider.js'
import { FakeLLM } from '@career/core'
import { solveCaptcha } from '../src/solvers/index.js'
import { detectCaptcha } from '../src/detect.js'
import { FakeCaptchaPage } from './helpers.js'
import sharp from 'sharp'

const noSleep = async () => {}
const midRand = () => 0.5

describe('estimateGapFromColumns（缺口列检测纯函数）', () => {
  it('平坦 + 单一高原 → 定位高原起点附近', () => {
    const cols = new Array(100).fill(1)
    for (let i = 42; i < 62; i++) cols[i] = 9
    const hit = estimateGapFromColumns(cols)!
    expect(hit).not.toBeNull()
    expect(hit.index).toBeGreaterThanOrEqual(42)
    expect(hit.index).toBeLessThanOrEqual(62)
    expect(hit.confidence).toBeGreaterThan(0.3)
  })
  it('太平坦的图不给答案', () => {
    expect(estimateGapFromColumns(new Array(100).fill(1))).toBeNull()
  })
  it('太短的列不给答案', () => {
    expect(estimateGapFromColumns([1, 2, 3])).toBeNull()
  })
})

describe('solveCaptcha 调度', () => {
  it('sms 永远 unsupported（契约红线）', async () => {
    const page = new FakeCaptchaPage()
    const r = await solveCaptcha({ page, llm: new FakeLLM(), sleep: noSleep, rand: midRand }, { kind: 'sms', vendor: 'unknown' })
    expect(r.outcome).toBe('unsupported')
    expect(r.attempts).toBe(0)
  })
  it('没有 CDP 会话 → needs_cdp（不盲试 DOM 事件）', async () => {
    const page = new FakeCaptchaPage({ hasCdp: false })
    const r = await solveCaptcha({ page, llm: new FakeLLM(), sleep: noSleep, rand: midRand }, { kind: 'slider', vendor: 'geetest' })
    expect(r.outcome).toBe('needs_cdp')
  })
})

describe('滑块求解（FakeLLM 路径）', () => {
  it('视觉给距离 → 拖动 → 核验通过', async () => {
    const page = new FakeCaptchaPage({
      evals: [
        // 探针：把手 + 轨道 + 无成功标志
        { match: 'geetest_slider_button', result: { handle: { x: 20, y: 300, width: 40, height: 40 }, track: { x: 20, y: 300, width: 280, height: 60 }, hasSuccess: false } },
        // 拖完核验：通过
        { match: 'geetest_success', result: true },
      ],
    })
    const llm = new FakeLLM([JSON.stringify({ distance: 150, confidence: 0.9 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'slider', vendor: 'geetest' })
    expect(r.outcome).toBe('passed')
    expect(r.attempts).toBe(1)
    const drag = page.cdpInstance.mouseEvents()
    expect(drag.some(e => e.params.type === 'mousePressed')).toBe(true)
    const release = drag.find(e => e.params.type === 'mouseReleased')!
    expect(release.params.x).toBeCloseTo(20 + 40 / 2 + 150, 1) // 把手中心 x=40 + 距离 150 = 190
  })
  it('视觉低置信度 → failed 不瞎拖', async () => {
    const page = new FakeCaptchaPage({
      evals: [{ match: 'geetest_slider_button', result: { handle: { x: 20, y: 300, width: 40, height: 40 }, track: { x: 20, y: 300, width: 280, height: 60 }, hasSuccess: false } }],
    })
    const llm = new FakeLLM([JSON.stringify({ distance: 150, confidence: 0.2 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 2 }, { kind: 'slider', vendor: 'geetest' })
    expect(r.outcome).toBe('failed')
    expect(page.cdpInstance.mouseEvents().length).toBe(0) // 没有产生任何拖动
  })
})

describe('点选求解（网格化坐标）', () => {
  it('模型报格子号 → 换算容器中心坐标点击', async () => {
    const page = new FakeCaptchaPage({
      evals: [
        // 容器：100,100 起 300x200 → 网格 8 列 × 5 行
        { match: 'geetest_item_wrap', result: { x: 100, y: 100, width: 300, height: 200 } },
        // 核验通过
        { match: 'geetest_success', result: true },
      ],
    })
    const llm = new FakeLLM([JSON.stringify({ cells: [1, 30], confidence: 0.9 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'image_click', vendor: 'geetest' })
    expect(r.outcome).toBe('passed')
    const clicks = page.cdpInstance.mouseEvents().filter(e => e.params.type === 'mousePressed')
    expect(clicks.length).toBe(2)
    const cw = 300 / 8, ch = 200 / 5
    expect(clicks[0].params.x).toBeCloseTo(100 + cw * 0.5, 1)
    expect(clicks[0].params.y).toBeCloseTo(100 + ch * 0.5, 1)
    // 30 号：col=(30-1)%8=5, row=3
    expect(clicks[1].params.x).toBeCloseTo(100 + cw * 5.5, 1)
    expect(clicks[1].params.y).toBeCloseTo(100 + ch * 3.5, 1)
  })
  it('格子号越界 → failed 不点', async () => {
    const page = new FakeCaptchaPage({
      evals: [{ match: 'geetest_item_wrap', result: { x: 100, y: 100, width: 300, height: 200 } }],
    })
    const llm = new FakeLLM([JSON.stringify({ cells: [999], confidence: 0.9 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'image_click', vendor: 'geetest' })
    expect(r.outcome).toBe('failed')
    expect(page.cdpInstance.mouseEvents().filter(e => e.params.type === 'mousePressed').length).toBe(0)
  })
  it('极小容器退回归一化坐标', async () => {
    const page = new FakeCaptchaPage({
      evals: [
        { match: 'geetest_item_wrap', result: { x: 50, y: 50, width: 40, height: 40 } },
        { match: 'geetest_success', result: true },
      ],
    })
    const llm = new FakeLLM([JSON.stringify({ order: [{ x: 500, y: 500 }], confidence: 0.9 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'image_click', vendor: 'geetest' })
    expect(r.outcome).toBe('passed')
    const click = page.cdpInstance.mouseEvents().find(e => e.params.type === 'mousePressed')!
    expect(click.params.x).toBeCloseTo(50 + 20, 1)
    expect(click.params.y).toBeCloseTo(50 + 20, 1)
  })
})

describe('detectCaptcha（探针结果归一化）', () => {
  it('厂商 + 种类 + 容器透传', async () => {
    const page = new FakeCaptchaPage({
      evals: [{ match: 'document.body', result: { kind: 'slider', vendor: 'geetest', rect: { x: 1, y: 2, width: 300, height: 80 }, prompt: '拖动滑块完成拼图', text: '' } }],
    })
    const t = await detectCaptcha(page)
    expect(t).toEqual({ kind: 'slider', vendor: 'geetest', rect: { x: 1, y: 2, width: 300, height: 80 }, prompt: '拖动滑块完成拼图' })
  })
  it('探针返回 null → 没有验证码', async () => {
    const page = new FakeCaptchaPage({ evals: [] })
    expect(await detectCaptcha(page)).toBeNull()
  })
  it('未知厂商 + 未知种类 → null', async () => {
    const page = new FakeCaptchaPage({ evals: [{ match: 'document.body', result: { kind: 'unknown', vendor: 'unknown' } }] })
    expect(await detectCaptcha(page)).toBeNull()
  })
})

describe('滑块图像兜底', () => {
  it('视觉低置信度时用真实像素边缘估距，仍须拖动后核验', async () => {
    const raw = Buffer.alloc(320 * 160, 150)
    for (let y = 20; y < 120; y++) for (let x = 120; x < 155; x++) raw[y * 320 + x] = 20
    const png = await sharp(raw, { raw: { width: 320, height: 160, channels: 1 } }).png().toBuffer()
    const page = new FakeCaptchaPage({ evals: [
      { match: 'geetest_slider_button', result: { handle: { x: 20, y: 300, width: 40, height: 40 }, track: { x: 20, y: 300, width: 320, height: 60 }, hasSuccess: false } },
      { match: 'geetest_success', result: true },
    ] })
    page.cdpInstance.reply('Page.captureScreenshot', () => ({ data: png.toString('base64') }))
    const llm = new FakeLLM([JSON.stringify({ distance: 120, confidence: 0.1 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'slider', vendor: 'geetest' })
    expect(r.outcome).toBe('passed')
    expect(r.attempts).toBe(1)
    expect(llm.calls).toHaveLength(0)
  })
})

describe('旋转求解', () => {
  const rotationPage = () => new FakeCaptchaPage({ evals: [
    { match: 'geetest_slider_button', result: { handle: { x: 40, y: 400, width: 40, height: 40 }, track: { x: 40, width: 360 }, region: { x: 40, y: 100, width: 360, height: 280 } } },
    { match: '使图片为正', result: true },
  ] })
  it('估角后按方向拖动，核验通过才算成功', async () => {
    const page = rotationPage()
    const llm = new FakeLLM([JSON.stringify({ angle: 90, confidence: 0.9 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'rotation', vendor: 'geetest' })
    expect(r.outcome).toBe('passed')
    expect(page.cdpInstance.commands.filter(c => c.method === 'Page.captureScreenshot')).toHaveLength(1)
    const release = page.cdpInstance.mouseEvents().find(e => e.params.type === 'mouseReleased')!
    expect(release.params.x).toBeGreaterThan(60)
  })
  it('估角低置信度时不拖动', async () => {
    const page = rotationPage()
    const llm = new FakeLLM([JSON.stringify({ angle: 90, confidence: 0.1 })])
    const r = await solveCaptcha({ page, llm, sleep: noSleep, rand: midRand, maxAttempts: 1 }, { kind: 'rotation', vendor: 'geetest' })
    expect(r.outcome).toBe('failed')
    expect(page.cdpInstance.mouseEvents()).toHaveLength(0)
  })
})
