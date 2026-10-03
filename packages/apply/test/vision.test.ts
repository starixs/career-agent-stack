import { describe, it, expect } from 'vitest'
import { FakePage, FakePerceiver, driveApplication, el, editDistance, fuzzyEquals, locateInputForLabel, locateButton, pairVisualFields, looksLikeFormVisually, visionFill, visionClickText, type Perception } from '../src/index.js'
import { profile, noLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const vp = { width: 1280, height: 800 }

/** 一张"看起来像表单"的截图感知：标签在左、输入框在右；按钮在底部。 */
function formFrame(extra: Perception['elements'] = []): Perception {
  return {
    source: 'fake', viewport: vp,
    elements: [
      el('text', '姓名', [40, 100, 60, 24]), el('input', '', [140, 96, 240, 32], 0.8, 'in-name'),
      el('text', '手机号', [40, 160, 70, 24]), el('input', '', [140, 156, 240, 32], 0.8, 'in-phone'),
      el('text', '邮箱', [40, 220, 60, 24]), el('input', '', [140, 216, 240, 32], 0.8, 'in-email'),
      ...extra,
    ],
  }
}

describe('perception 几何匹配', () => {
  it('标签 → 右侧 / 下方输入框；找不到输入框退回标签本身', () => {
    const p = formFrame([el('text', '个人简介', [40, 300, 80, 24]), el('input', '', [40, 330, 400, 80], 0.8, 'in-bio'), el('text', '微信号', [40, 500, 60, 24])])
    expect(locateInputForLabel(p, '手机号码')?.target.id).toBe('in-phone')
    expect(locateInputForLabel(p, '手机号码')?.via).toBe('right')
    expect(locateInputForLabel(p, '个人简介')).toMatchObject({ via: 'below', target: { id: 'in-bio' } })
    expect(locateInputForLabel(p, '微信号')?.via).toBe('label')
    expect(locateInputForLabel(p, '不存在的字段')).toBeNull()
  })
  it('pairVisualFields 把输入框配上最近的标签；looksLikeFormVisually', () => {
    const p = formFrame()
    expect(pairVisualFields(p).map(v => v.label)).toEqual(['姓名', '手机号', '邮箱'])
    expect(looksLikeFormVisually(p)).toBe(true)
    expect(looksLikeFormVisually({ source: 'fake', viewport: vp, elements: [el('text', '职位介绍', [0, 0, 100, 20])] })).toBe(false)
  })
  it('locateButton 优先按钮类元素，支持多个候选文案', () => {
    const p = formFrame([el('button', '保存并下一步', [40, 400, 120, 36]), el('text', '下一步提示', [300, 400, 80, 20])])
    expect(locateButton(p, ['下一步', '继续'])?.text).toBe('保存并下一步')
    expect(locateButton(p, ['提交'])).toBeNull()
  })
  it('OCR 容错：一字之差的按钮文案也能命中，但不会把"提交"当成"提交申请"', () => {
    expect(fuzzyEquals('提交申谱', '提交申请')).toBe(true)
    expect(fuzzyEquals('下-步', '下一步')).toBe(true)
    expect(fuzzyEquals('提交', '提交申请')).toBe(false)
    expect(fuzzyEquals('继续填写申请表并提交', '继续')).toBe(false)
    const p = formFrame([el('text', '提交申谱', [54, 322, 88, 24])])
    expect(locateButton(p, ['提交', '确认提交', '提交申请'])?.text).toBe('提交申谱')
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('视觉兜底层原子动作（FakePage 坐标命中）', () => {
  it('visionFill：点进输入框、清空、逐字键入；找不到就向下滚再找', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', box: [140, 96, 240, 32], domHidden: true, value: '旧值' }] })
    const perceiver = new FakePerceiver(formFrame())
    const r = await visionFill(page, { perceiver, pause: [0, 0], typeDelayMs: 0, sleep: async () => {} }, '姓名', '张三')
    expect(r.ok).toBe(true); expect(r.via).toBe('right')
    expect(page.valueOf('姓名')).toBe('张三')
    expect(page.actions.filter(a => a.kind === 'mouse').length).toBe(1)
    // 第一帧没有，滚动后第二帧出现
    const page2 = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '邮箱', box: [140, 216, 240, 32], domHidden: true }] })
    const scrolling = new FakePerceiver([{ source: 'fake', viewport: vp, elements: [el('text', '页面标题', [0, 0, 100, 20])] }, formFrame()])
    const r2 = await visionFill(page2, { perceiver: scrolling, pause: [0, 0], typeDelayMs: 0, sleep: async () => {} }, '邮箱', 'a@b.com')
    expect(r2.ok).toBe(true); expect(scrolling.calls).toBe(2)
    expect(page2.actions.some(a => a.kind === 'scroll')).toBe(true)
    expect(page2.valueOf('邮箱')).toBe('a@b.com')
  })
  it('visionClickText：拒绝提交类文案，只点下一步', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', buttons: [{ text: '提交申请', submit: true, box: [40, 400, 100, 36], domHidden: true }, { text: '下一步', box: [200, 400, 100, 36], domHidden: true }] })
    const perceiver = new FakePerceiver(formFrame([el('button', '提交申请', [40, 400, 100, 36]), el('button', '下一步', [200, 400, 100, 36])]))
    const refused = await visionClickText(page, { perceiver, pause: [0, 0], sleep: async () => {} }, ['提交申请'], t => /提交/.test(t))
    expect(refused.clicked).toBeNull(); expect(refused.refused).toBe('提交申请'); expect(page.submitted).toBe(false)
    const ok = await visionClickText(page, { perceiver, pause: [0, 0], sleep: async () => {} }, ['下一步'], t => /提交/.test(t))
    expect(ok.clicked?.text).toBe('下一步')
    expect(page.actions.some(a => a.kind === 'click' && a.target === 'button:下一步')).toBe(true)
  })
})

describe('driveApplication 分层降级', () => {
  it('DOM 抽不到字段 → 视觉层伪字段 → 坐标填写 → 视觉找提交按钮并停下', async () => {
    const page = new FakePage({
      url: 'https://x.com/apply',
      fields: [{ label: '姓名', box: [140, 96, 240, 32], domHidden: true }, { label: '手机号', box: [140, 156, 240, 32], domHidden: true }, { label: '邮箱', box: [140, 216, 240, 32], domHidden: true }],
      buttons: [{ text: '提交', submit: true, box: [40, 400, 100, 36], domHidden: true }],
    })
    const perceiver = new FakePerceiver(formFrame([el('button', '提交', [40, 400, 100, 36])]))
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, perceiver })
    expect(r.status).toBe('stopped_before_submit'); expect(r.submitButton).toBe('提交')
    expect(r.layersUsed).toEqual(['vision'])
    expect(r.pages[0].layer).toBe('vision')
    expect(r.filled.map(f => [f.label, f.value, f.layer])).toEqual([['姓名', '张三', 'vision'], ['手机号', '13800000000', 'vision'], ['邮箱', 'zhangsan@example.com', 'vision']])
    expect(page.fieldValues()).toMatchObject({ 姓名: '张三', 手机号: '13800000000', 邮箱: 'zhangsan@example.com' })
    expect(r.escalations.map(e => [e.reason, e.outcome])).toEqual([['no_fields', 'recovered'], ['no_next_button', 'stopped']])
    expect(page.submitted).toBe(false)
  })
  it('DOM 填不进去（自定义组件吞输入）→ 视觉层坐标重填并用 DOM 核对通过', async () => {
    // rejectFill + actuatorFails：Playwright 填不进、页内执行器也填不进（完全自绘控件）→ 只剩视觉层
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }, { label: '手机号', rejectFill: true, actuatorFails: true, box: [140, 156, 240, 32] }], buttons: ['提交'] })
    const perceiver = new FakePerceiver(formFrame())
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, perceiver })
    expect(r.status).toBe('stopped_before_submit')
    expect(r.mismatches).toEqual([])
    expect(page.valueOf('手机号')).toBe('13800000000')
    expect(r.escalations).toEqual([{ reason: 'fill_mismatch', field: '手机号', outcome: 'recovered', evidence: expect.stringContaining('视觉层键入') }])
    expect(r.filled.find(f => f.label === '手机号')?.layer).toBe('vision')
    expect(r.layersUsed).toEqual(['dom', 'vision'])
  })
  it('DOM 没有任何按钮 → 视觉层找到"下一步"并点击进入下一页', async () => {
    const page = new FakePage([
      { url: 'https://x.com/p1', fields: [{ label: '姓名' }], buttons: [{ text: '下一步', goto: 'https://x.com/p2', box: [200, 400, 100, 36], domHidden: true }] },
      { url: 'https://x.com/p2', fields: [{ label: '邮箱' }], buttons: [{ text: '提交', submit: true }] },
    ])
    const perceiver = new FakePerceiver(formFrame([el('button', '下一步', [200, 400, 100, 36])]))
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, perceiver })
    expect(r.status).toBe('stopped_before_submit')
    expect(r.pages.length).toBe(2)
    expect(r.pages[0].nextButton).toBe('下一步')
    expect(r.escalations[0]).toMatchObject({ reason: 'no_next_button', outcome: 'recovered' })
    expect(page.visited).toEqual(['https://x.com/p1', 'https://x.com/p2'])
  })
  it('没有感知器时行为不变；页面不支持 mouse 时也不走视觉层', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', domHidden: true }] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('blocked'); expect(r.layersUsed).toEqual([])
    const noMouse = Object.assign(Object.create(Object.getPrototypeOf(page)), page, { mouse: undefined }) as FakePage
    const r2 = await driveApplication(noMouse, noLLM(), profile, { ...quiet, perceiver: new FakePerceiver(formFrame()) })
    expect(r2.status).toBe('blocked'); expect(r2.layersUsed).toEqual([])
  })
  it('截图感知也看不到表单 → blocked，记录 no_fields failed', async () => {
    const page = new FakePage({ url: 'https://x.com/jd', text: '职位介绍' })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, perceiver: new FakePerceiver({ source: 'fake', viewport: vp, elements: [el('text', '职位介绍', [0, 0, 100, 20])] }) })
    expect(r.status).toBe('blocked')
    expect(r.escalations).toEqual([{ reason: 'no_fields', outcome: 'failed', evidence: expect.stringContaining('截图感知也没看到表单') }])
  })
})
