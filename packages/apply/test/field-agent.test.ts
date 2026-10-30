import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { agentFill, typedFromValue, AGENT_MAX_STEPS } from '../src/field-agent.js'
import type { FormField } from '../src/extract.js'
import type { PageLike } from '../src/page.js'
import type { PageScript } from '../src/scripts.js'
import { WIDGET_SCRIPT_IDS, type SemanticNode } from '../src/widgets.js'

/**
 * 假下拉：点输入框展开，点选项选中；可以设成「被遮罩挡住」（真实鼠标点不到，只能直接派发）。
 * 只实现兜底代理用到的几个页内脚本。
 */
function fakeSelect(opts: { blocked?: boolean; options?: string[] } = {}) {
  const options = opts.options ?? ['博士', '硕士', '本科']
  const state = { open: false, display: '', clicks: [] as string[], typed: '' }
  const nodes = (): SemanticNode[] => [
    { ref: 'r0', tag: 'span', text: '学历' },
    { ref: 'r1', tag: 'input', text: '请选择', editable: false },
    { ref: 'r9', tag: 'button', text: '提交申请' },
    ...(state.open ? options.map((t, i) => ({ ref: `r${i + 2}`, tag: 'span', text: t, inPopup: true })) : []),
  ]
  const clickRef = (ref: string) => {
    state.clicks.push(ref)
    if (ref === 'r1') { state.open = !state.open; return }
    const hit = nodes().find(n => n.ref === ref && n.inPopup)
    if (hit) { state.display = hit.text; state.open = false }
  }
  const refOf = (sel: string) => /data-career-ref="(r\d+)"/.exec(sel)?.[1] ?? ''
  let pointed = ''
  const page = {
    evaluate: async <A, R>(script: PageScript<A, R>, arg?: A): Promise<R> => {
      const sel = (arg as { selector?: string } | undefined)?.selector ?? ''
      switch (script.id) {
        case WIDGET_SCRIPT_IDS.semanticContext: return { nodes: nodes() } as R
        case 'career.agentPoint': pointed = refOf(sel); return { ok: true, x: 10, y: 10, hittable: !opts.blocked, cover: opts.blocked ? 'div.mask' : undefined } as R
        case 'career.agentDispatchClick': clickRef(refOf(sel)); return true as R
        case 'career.agentScroll': return { ok: true, moved: false } as R
        case WIDGET_SCRIPT_IDS.activeEditable: return { editable: false, isTarget: false, tag: 'input' } as R
        default: throw new Error(`没实现 ${script.id}`)
      }
    },
    mouse: { click: async () => { clickRef(pointed) } },
    keyboard: { type: async (t: string) => { state.typed += t }, press: async () => {} },
    click: async (sel: string) => clickRef(refOf(sel)),
    waitForTimeout: async () => {},
  } as unknown as PageLike
  return { page, state, verify: async () => ({ ok: state.display === '本科', display: state.display }) }
}
const field = { id: 'f14', label: '学历', type: 'select', selector: '[data-career-field="f14"]', options: [], required: true } as unknown as FormField
const says = (...replies: object[]) => new FakeLLM(replies.map(r => JSON.stringify(r)))

describe('字段兜底代理：结构树没办成，模型接着办', () => {
  it('结构层把整个列表当成一项、没对上 → 模型点开、选中、核验通过；线索进了提示', async () => {
    const s = fakeSelect()
    const llm = says({ note: '先点开', action: 'click', ref: 'r1' }, { note: '本科在列表里', action: 'click', ref: 'r4' })
    const r = await agentFill({ page: s.page, llm }, field, '本科', { hint: '下拉选项里没有和你的资料对得上的；认出的选项：博士硕士本科' }, s.verify)
    expect(r).toMatchObject({ verified: true, display: '本科', steps: 2 })
    expect(llm.calls[0].messages[0].content).toContain('认出的选项：博士硕士本科')
    expect(llm.calls[1].messages[0].content).toContain('1. 先点开 → click r1')
  })

  it('被遮罩挡住：真实鼠标点不到就直接派发点击，不报错，回执写进工作记忆', async () => {
    const s = fakeSelect({ blocked: true })
    const steps: string[] = []
    const llm = says({ note: '点开', action: 'click', ref: 'r1' }, { note: '选本科', action: 'click', ref: 'r4' })
    const r = await agentFill({ page: s.page, llm, trace: x => steps.push(x) }, field, '本科', {}, s.verify)
    expect(r.verified).toBe(true)
    expect(steps[0]).toContain('被「div.mask」挡住，改为直接派发点击')
  })

  it('规则拦下：不点提交、不打资料里没有的字；模型说办不到就带着原因停下（原因给调用方记日志）', async () => {
    const s = fakeSelect()
    const llm = says(
      { note: '点提交', action: 'click', ref: 'r9' },
      { note: '编一个', action: 'type', ref: 'r1', text: '北京大学' },
      { note: '列表里只有博士和硕士', action: 'give_up', reason: '选项里没有本科' },
    )
    const r = await agentFill({ page: s.page, llm }, field, '本科', {}, s.verify)
    expect(r).toMatchObject({ verified: false, reason: '选项里没有本科' })
    expect(s.state.clicks).toEqual([])
    expect(s.state.typed).toBe('')
    expect(llm.calls[2].messages[0].content).toContain('不合规则，没执行')
  })

  it('原地打转就停；模型报错也不抛，按没办成返回', async () => {
    const s = fakeSelect()
    const stubborn = says(...Array.from({ length: AGENT_MAX_STEPS }, () => ({ note: '再点标题', action: 'click', ref: 'r0' })))
    const r = await agentFill({ page: s.page, llm: stubborn }, field, '本科', {}, s.verify)
    expect(r.verified).toBe(false)
    expect(r.steps).toBeLessThan(AGENT_MAX_STEPS)
    expect(stubborn.calls.some(c => String(c.messages[0].content).includes('换一种方式'))).toBe(true)
    const broken = new FakeLLM([])
    const r2 = await agentFill({ page: s.page, llm: broken }, field, '本科', {}, s.verify)
    expect(r2.verified).toBe(false)
  })

  it('看着填上了还要离开这一格再读：只是搜索词（离开就没了）不算，提醒模型去点选项', async () => {
    const s = fakeSelect()
    // 第一次选中只是搜索词：离开后被清空；第二次点选才真正提交
    const commit = async () => {
      const ok = s.state.clicks.filter(r => r === 'r4').length >= 2 && s.state.display === '本科'
      if (!ok) s.state.display = ''
      return { ok, display: s.state.display }
    }
    const llm = says({ note: '点开', action: 'click', ref: 'r1' }, { note: '选本科', action: 'click', ref: 'r4' }, { note: '再点开', action: 'click', ref: 'r1' }, { note: '点选本科', action: 'click', ref: 'r4' })
    const r = await agentFill({ page: s.page, llm }, field, '本科', {}, s.verify, commit)
    expect(r).toMatchObject({ verified: true, display: '本科' })
    expect(String(llm.calls[2].messages[0].content)).toContain('刚才只是搜索词，要点选下拉里的选项')
  })

  it('打的字只能来自目标值：目标值的一部分，或同一个日期的另一种写法', () => {
    expect(typedFromValue('华东理工', '华东理工大学')).toBe(true)
    expect(typedFromValue('2023年09月', '2023-09')).toBe(true)
    expect(typedFromValue('2023/09', '2023-09')).toBe(true)
    expect(typedFromValue('复旦', '华东理工大学')).toBe(false)
    expect(typedFromValue('2024-09', '2023-09')).toBe(false)
  })
})
