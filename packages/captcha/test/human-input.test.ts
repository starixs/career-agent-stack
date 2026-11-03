import { describe, it, expect } from 'vitest'
import { bezierPoints, humanClick, humanDrag, humanType, warmUpInput } from '../src/human-input.js'
import { FakeCdp } from './helpers.js'

// 固定随机源：让抖动 / 路径可断言
const seqRand = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length] }
const midRand = () => 0.5
const noSleep = async () => {}

describe('bezierPoints', () => {
  it('端点精确落在起点终点', () => {
    const pts = bezierPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 50 }, { x: 70, y: -50 }, 10)
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 0 })
    expect(pts.every(p => p.x >= -1 && p.x <= 101)).toBe(true)
  })
  it('单步也在端点上', () => {
    const pts = bezierPoints({ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 1.5, y: 3 }, { x: 1.5, y: 0 }, 1)
    expect(pts).toEqual([{ x: 2, y: 2 }])
  })
})

describe('warmUpInput', () => {
  it('先发一次无害 mouseMoved(0,0)（attach 后 infobar 推挤的坐标系预热）', async () => {
    const cdp = new FakeCdp()
    await warmUpInput({ cdp, sleep: noSleep })
    const m = cdp.mouseEvents()
    expect(m.length).toBe(1)
    expect(m[0].params).toMatchObject({ type: 'mouseMoved', x: 0, y: 0 })
  })
})

describe('humanClick 三事件序列', () => {
  it('mouseMoved → mousePressed → mouseReleased，间隔事件顺序不乱', async () => {
    const cdp = new FakeCdp()
    await humanClick({ cdp, rand: midRand, sleep: noSleep }, 300, 200)
    const types = cdp.mouseTypes()
    const pressed = types.indexOf('mousePressed')
    const released = types.indexOf('mouseReleased')
    expect(types[types.length - 1]).toBe('mouseReleased')
    expect(pressed).toBeGreaterThan(-1)
    expect(released).toBe(pressed + 1) // 按下与松开之间没有别的鼠标事件
    expect(types.slice(0, pressed).every(t => t === 'mouseMoved')).toBe(true) // 之前全是移动
  })
  it('落点带 ±1.5px 误差（rand=0.5 时正好是中心）', async () => {
    const cdp = new FakeCdp()
    await humanClick({ cdp, rand: midRand, sleep: noSleep }, 100, 60)
    const press = cdp.mouseEvents().find(e => e.params.type === 'mousePressed')!
    expect(press.params.x).toBeCloseTo(100, 1)
    expect(press.params.y).toBeCloseTo(60, 1)
  })
  it('button/left + buttons=1 的原生语义', async () => {
    const cdp = new FakeCdp()
    await humanClick({ cdp, rand: midRand, sleep: noSleep }, 10, 10)
    const press = cdp.mouseEvents().find(e => e.params.type === 'mousePressed')!
    expect(press.params.button).toBe('left')
    expect(press.params.buttons).toBe(1)
  })
})

describe('humanType', () => {
  it('逐字符 keyDown(text) → keyUp，VK 码用字符码', async () => {
    const cdp = new FakeCdp()
    await humanType({ cdp, rand: midRand, sleep: noSleep }, 'A1')
    const keys = cdp.keyEvents()
    expect(keys.length).toBe(4)
    expect(keys[0].params).toMatchObject({ type: 'keyDown', text: 'A', windowsVirtualKeyCode: 65 })
    expect(keys[1].params.type).toBe('keyUp')
    expect(keys[2].params).toMatchObject({ type: 'keyDown', text: '1' })
  })
  it('Enter 走 VK 码表', async () => {
    const cdp = new FakeCdp()
    await humanType({ cdp, rand: midRand, sleep: noSleep }, '\r')
    expect(cdp.keyEvents()[0].params.windowsVirtualKeyCode).toBe(13)
  })
})

describe('humanDrag（滑块轨迹）', () => {
  it('按下 → 一串按住的移动 → 松开，终点 = 起点 + 距离', async () => {
    const cdp = new FakeCdp()
    await humanDrag({ cdp, rand: midRand, sleep: noSleep }, { x: 100, y: 300 }, 220, { durationMs: 10 })
    const types = cdp.mouseTypes()
    expect(types[0]).toBe('mousePressed')
    expect(types[types.length - 1]).toBe('mouseReleased')
    const moves = types.slice(1, -1)
    expect(moves.length).toBeGreaterThan(10)
    expect(moves.every(t => t === 'mouseMoved')).toBe(true)
    const release = cdp.mouseEvents().find(e => e.params.type === 'mouseReleased')!
    expect(release.params.x).toBeCloseTo(320, 1)
    // 过冲：中途最远点超过目标
    const maxX = Math.max(...cdp.mouseEvents().map(e => e.params.x as number))
    expect(maxX).toBeGreaterThan(320)
  })
  it('移动事件全程按住（buttons=1）', async () => {
    const cdp = new FakeCdp()
    await humanDrag({ cdp, rand: midRand, sleep: noSleep }, { x: 0, y: 0 }, 50, { durationMs: 5 })
    const move = cdp.mouseEvents().find(e => e.params.type === 'mouseMoved')!
    expect(move.params.buttons).toBe(1)
  })
  it('随机抖动不把端点拖飞（rand 全 0.99 也在容差内）', async () => {
    const cdp = new FakeCdp()
    const r = seqRand([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.5])
    await humanDrag({ cdp, rand: r, sleep: noSleep }, { x: 10, y: 10 }, 100, { durationMs: 5 })
    const release = cdp.mouseEvents().find(e => e.params.type === 'mouseReleased')!
    expect(release.params.x).toBeCloseTo(110, 1)
  })
})
