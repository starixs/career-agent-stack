import { describe, it, expect } from 'vitest'
import { FakePage, driveApplication, submitApplication, formSignatureOf, openAnswersHashOf } from '../src/index.js'
import { profile, noLLM } from './helpers.js'

const basics = [{ label: '姓名', required: true }, { label: '邮箱', type: 'email' as const }, { label: '手机号', type: 'tel' as const }]
const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const fast = { pollMs: 1, timeoutMs: 20 }

describe('填后检查（审阅清单）', () => {
  it('全部填好：attention 为 0，必填计数对上，给出界面指纹', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: basics, buttons: [{ text: '提交申请', submit: true }] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('stopped_before_submit')
    expect(r.review).toBeDefined()
    expect(r.review!.attention).toBe(0)
    expect(r.review!.requiredTotal).toBe(1)
    expect(r.review!.requiredFilled).toBe(1)
    expect(r.review!.formSignature).toMatch(/^[0-9a-f]{24}$/)
  })

  it('必填但资料里没有 → needs_user 进清单；站点校验错误也进清单', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [...basics, { label: '紧急联系人关系', required: true }], errors: ['请填写完整信息'], buttons: [{ text: '提交', submit: true }] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    const rows = r.review!.rows
    expect(rows.find(x => x.label === '紧急联系人关系')?.status).toMatch(/needs_user|empty/)
    expect(rows.find(x => x.status === 'site_error')?.label).toBe('请填写完整信息')
    expect(r.review!.attention).toBeGreaterThanOrEqual(2)
  })

  it('同一张表（标签一样）指纹相同，与填的值、网址参数无关；开放题哈希随内容变化', () => {
    const a = formSignatureOf('https://www.x.com/apply?job=1', [{ label: '姓名*', type: 'text' }, { label: '邮箱', type: 'email' }])
    const b = formSignatureOf('https://x.com/apply?job=2', [{ label: '邮箱', type: 'email' }, { label: '姓名', type: 'text' }])
    expect(a).toBe(b)
    expect(openAnswersHashOf([{ label: '为什么选择我们', value: '因为 A' }])).not.toBe(openAnswersHashOf([{ label: '为什么选择我们', value: '因为 B' }]))
  })
})

describe('submitApplication', () => {
  it('点提交并按成功文案判定已投递', async () => {
    const page = new FakePage([
      { url: 'https://x.com/apply', fields: [{ label: '姓名', required: true, value: '张三' }], buttons: [{ text: '提交申请', submit: true, goto: 'https://x.com/done' }] },
      { url: 'https://x.com/done', text: '投递成功！我们会尽快与你联系' },
    ])
    const r = await submitApplication(page, { expectedButton: '提交申请', ...fast })
    expect(r.status).toBe('submitted')
    expect(r.evidence).toBe('投递成功')
    expect(page.submitted).toBe(true)
  })

  it('必填为空：不点提交，返回 needs_user', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', required: true }], buttons: [{ text: '提交', submit: true }] })
    const r = await submitApplication(page, fast)
    expect(r.status).toBe('needs_user')
    expect(r.missingRequired).toEqual(['姓名'])
    expect(page.submitted).toBe(false)
  })

  it('网站拒绝（出现新校验错误）→ failed；记录用户在页面上的改动', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '期望城市', required: true, value: '上海' }], buttons: [{ text: '提交', submit: true, submitErrors: ['手机号格式不正确'] }] })
    const r = await submitApplication(page, { filled: [{ fieldId: 'f0', label: '期望城市', value: '北京', source: 'answer_bank' }], ...fast })
    expect(r.status).toBe('failed')
    expect(r.errors).toEqual(['手机号格式不正确'])
    expect(r.edits).toEqual([{ label: '期望城市', before: '北京', after: '上海' }])
  })

  it('点了但没有任何反馈 → uncertain（不当作已投递）', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', required: true, value: '张三' }], buttons: [{ text: '提交', submit: true }] })
    const r = await submitApplication(page, fast)
    expect(r.status).toBe('uncertain')
  })

  it('找不到提交按钮 → failed，不乱点', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名', required: true, value: '张三' }], buttons: ['保存草稿'] })
    const r = await submitApplication(page, fast)
    expect(r.status).toBe('failed')
    expect(page.actions.some(a => a.kind === 'click')).toBe(false)
  })
})
