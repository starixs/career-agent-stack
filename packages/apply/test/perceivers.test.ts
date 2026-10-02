import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { DomBoxPerceiver, FakePage, FakePerceiver, VlmPerceiver, composePerceivers, driveApplication, el, looksLikeFieldLabel, synthesizeInputsFromLabels, locateInputForLabel, type Perception } from '../src/index.js'
import { profile, noLLM } from './helpers.js'

const vp = { width: 1280, height: 800 }
const ctx = { viewport: vp }
const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('感知器实现', () => {
  it('DomBoxPerceiver：DOM 可见元素的包围盒（含标签 / 按钮）', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', box: [140, 96, 240, 32] }, { label: '隐藏', box: [140, 500, 240, 32], domHidden: true }], buttons: [{ text: '下一步', box: [200, 400, 100, 36] }] })
    const p = await new DomBoxPerceiver(page).perceive(new Uint8Array(), ctx)
    expect(p.source).toBe('dom-boxes')
    expect(p.elements.map(e => [e.kind, e.text])).toEqual([['input', ''], ['text', '姓名'], ['button', '下一步']])
    expect(locateInputForLabel(p, '姓名')?.target.box).toEqual({ x: 140, y: 96, w: 240, h: 32 })
  })
  it('composePerceivers 合并去重：重叠 ≥ 60% 的同类元素只留一个，补齐文字', async () => {
    const a = new FakePerceiver({ source: 'a', viewport: vp, elements: [el('input', '', [100, 100, 200, 30], 1, 'a1'), el('text', '姓名', [10, 100, 60, 24], 1, 'a2')] })
    const b = new FakePerceiver({ source: 'b', viewport: vp, elements: [el('input', '请输入', [104, 102, 196, 28], 0.5, 'b1'), el('button', '下一步', [10, 300, 80, 30], 0.9, 'b2')] })
    const p = await composePerceivers([a, b]).perceive(new Uint8Array(), ctx)
    expect(p.source).toBe('a+b')
    expect(p.elements.map(e => e.id)).toEqual(['a1', 'a2', 'b2'])
    expect(p.elements[0].text).toBe('请输入')
  })
  it('synthesizeInputsFromLabels：只认字的 OCR 结果按标签位置合成输入框', () => {
    const ocr: Perception = { source: 'ocr', viewport: vp, elements: [el('text', '姓名：', [40, 100, 60, 24]), el('text', '手机号', [40, 160, 70, 24]), el('text', '我们是一家很好的公司，欢迎加入。', [40, 40, 400, 24]), el('text', '个人简介', [40, 220, 80, 24]), el('text', '（最多 500 字）', [140, 220, 120, 24])] }
    const p = synthesizeInputsFromLabels(ocr)
    const inputs = p.elements.filter(e => e.kind === 'input')
    expect(inputs.length).toBe(3)
    expect(locateInputForLabel(p, '姓名')?.via).toBe('right')
    expect(locateInputForLabel(p, '个人简介')?.via).toBe('below') // 右侧被括号说明挡住 → 合成到下方
    expect(looksLikeFieldLabel('我们是一家很好的公司，欢迎加入。')).toBe(false)
    expect(looksLikeFieldLabel('期望工作城市')).toBe(true)
    // 已有输入框的感知不动
    expect(synthesizeInputsFromLabels({ ...ocr, elements: [...ocr.elements, el('input', '', [140, 96, 200, 30])] }).elements.length).toBe(ocr.elements.length + 1)
  })
  it('VlmPerceiver：把 OCR 编号表 + 截图交给模型，模型只做分类 / 补充；不支持图片的模型直接报错', async () => {
    const base = new FakePerceiver({ source: 'ocr', viewport: vp, elements: [el('text', '姓名', [40, 100, 60, 24], 0.9, 't1'), el('text', '下一步', [200, 400, 80, 30], 0.9, 't2')] })
    const llm = new FakeLLM([JSON.stringify({ elements: [{ n: 2, kind: 'button' }, { kind: 'input', text: '', box: { x: 140, y: 96, w: 240, h: 32 } }] })])
    const p = await new VlmPerceiver(llm, base).perceive(new Uint8Array([1, 2, 3]), { ...ctx, hint: '找姓名输入框' })
    expect(p.source).toBe('ocr+vlm')
    expect(p.elements.find(e => e.id === 't2')?.kind).toBe('button')
    expect(p.elements.find(e => e.kind === 'input')?.box).toEqual({ x: 140, y: 96, w: 240, h: 32 })
    expect(llm.calls[0].messages[0].images?.[0]).toMatchObject({ mediaType: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') })
    expect(llm.calls[0].messages[0].content).toContain('找姓名输入框')
    const textOnly = Object.assign(new FakeLLM(['{}']), { supportsImages: () => false })
    await expect(new VlmPerceiver(textOnly, base).perceive(new Uint8Array(), ctx)).rejects.toThrow('不支持图片')
  })
  it('端到端：DOM 盒子感知 + DOM 填不进去 → 坐标重填成功', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', box: [140, 96, 240, 32] }, { label: '手机号', rejectFill: true, box: [140, 156, 240, 32] }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, perceiver: new DomBoxPerceiver(page) })
    expect(r.status).toBe('stopped_before_submit')
    expect(r.mismatches).toEqual([])
    expect(page.valueOf('手机号')).toBe('13800000000')
    expect(r.escalations[0]).toMatchObject({ reason: 'fill_mismatch', outcome: 'recovered' })
  })
})
