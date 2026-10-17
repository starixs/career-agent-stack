import { describe, it, expect } from 'vitest'
import { FakePage, driveApplication, fillValueScript, SCRIPT_IDS } from '../src/index.js'
import { profile, noLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('页内执行器（quillfill dom-actuator 的 L1.5）', () => {
  it('antd 风格自定义下拉：点开 → 枚举选项 → 同义匹配点选 → 读回显示值核验（不打字、不回车）', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '最高学历', type: 'select', options: ['大学本科', '硕士研究生', '博士研究生'], framework: 'antd' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), { ...profile, basics: { ...profile.basics, degree: '硕士' } }, quiet)
    expect(r.status).toBe('stopped_before_submit')
    expect(page.valueOf('最高学历')).toBe('硕士研究生')
    expect(page.actions.filter(a => a.kind === 'option').map(a => a.value)).toEqual(['硕士研究生'])
    expect(page.actions.some(a => a.kind === 'type' || a.kind === 'press')).toBe(false) // 没走键入回车
    expect(r.mismatches).toEqual([])
    expect(r.filled[0]).toMatchObject({ label: '最高学历', verified: true, strategy: 'option-click', display: '硕士研究生' })
  })
  it('React 受控输入（Playwright fill 被吞）：读回不一致 → 页内执行器原型链 setter 重填成功，不动用视觉层', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '手机号', rejectFill: true }, { label: '姓名' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(page.valueOf('手机号')).toBe('13800000000')
    expect(r.mismatches).toEqual([])
    expect(r.escalations).toEqual([{ reason: 'fill_mismatch', field: '手机号', outcome: 'recovered', evidence: '页内执行器重填' }])
    expect(r.layersUsed).toEqual(['dom'])
  })
  it('第三方日期控件（element 日期框）：先走执行器 date 适配器，并按 placeholder 整形日期', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '毕业时间', framework: 'element', placeholder: 'YYYY/MM' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), { ...profile, basics: { ...profile.basics, graduation: '2026.06' } }, quiet)
    expect(page.valueOf('毕业时间')).toBe('2026/06')
    expect(page.actions.filter(a => a.kind === 'fill').map(a => a.value)).toEqual(['date:2026/06'])
    expect(r.filled[0]).toMatchObject({ value: '2026/06', verified: true })
  })
  it('执行器也填不进（actuatorFails）→ 宁空不错：清空回原值，标 needs_user + 原因码，不算已填', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '手机号', rejectFill: true, actuatorFails: true }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.mismatches).toEqual([])
    expect(r.filled).toEqual([])
    expect(r.needsUser).toEqual([expect.objectContaining({ label: '手机号', status: 'needs_user', code: 'readback_mismatch' })])
    expect(r.fields).toEqual([expect.objectContaining({ label: '手机号', status: 'needs_user', verified: false, code: 'readback_mismatch' })])
    expect(r.escalations).toEqual([])
  })
  it('脚本契约：找不到元素返回 ok=false，而不是抛错', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }] })
    const r = await page.evaluate(fillValueScript, { selector: '[data-career-field="nope"]', value: 'x' })
    expect(r).toMatchObject({ ok: false, strategy: 'none' })
    expect(fillValueScript.id).toBe(SCRIPT_IDS.fillValue)
  })
})
