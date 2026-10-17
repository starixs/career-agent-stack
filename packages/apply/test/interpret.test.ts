import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { FakePage, extractFields, interpretForm, findBankAnswer, beisen } from '../src/index.js'
import { profile, noLLM, draftLLM } from './helpers.js'

async function fieldsOf(spec: Parameters<typeof FakePage.prototype.evaluate>[0] extends never ? never : ConstructorParameters<typeof FakePage>[0]) { return extractFields(new FakePage(spec)) }

describe('interpret', () => {
  it('基本信息直接填，带 source=profile', async () => {
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '姓名' }, { label: '手机号码' }, { label: '学历', type: 'select', options: ['本科', '硕士'] }, { label: '性别', type: 'radio', options: ['男', '女'] }] })
    const plans = await interpretForm(noLLM(), fields, profile)
    expect(plans.map(p => [p.status, p.source, p.value])).toEqual([['fill', 'profile', '张三'], ['fill', 'profile', '13800000000'], ['fill', 'profile', '本科'], ['fill', 'profile', '男']])
    expect(plans.every(p => p.confidence > 0.8)).toBe(true)
  })
  it('高影响问题没有答案库原话 → needs_user，不调用模型', async () => {
    const llm = noLLM()
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '是否需要签证担保', required: true }, { label: '是否接受出差', type: 'select', options: ['是', '否'] }] })
    const plans = await interpretForm(llm, fields, { ...profile, answerBank: [] })
    expect(plans.every(p => p.status === 'needs_user' && p.source === 'none')).toBe(true)
    expect(llm.calls.length).toBe(0)
  })
  it('证件号只用私密库里本人存的号码，证件类型随号码推断；没存就不猜', async () => {
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '', placeholder: '请选择证件类型', type: 'select', options: ['居民身份证', '护照'] }, { label: '证件号码', required: true }] })
    const withId = await interpretForm(noLLM(), fields, { ...profile, basics: { ...profile.basics, idNumber: '11010120000101123X' } })
    expect(withId.map(p => [p.status, p.source, p.value])).toEqual([['fill', 'profile', '居民身份证'], ['fill', 'profile', '11010120000101123X']])
    const without = await interpretForm(noLLM(), fields, profile)
    expect(without[1]).toMatchObject({ status: 'needs_user', source: 'none' })
  })
  it('高影响问题有答案库原话 → 原话填，source=answer_bank', async () => {
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '期望薪资（月薪）' }] })
    const [p] = await interpretForm(noLLM(), fields, profile)
    expect(p).toMatchObject({ status: 'fill', source: 'answer_bank', value: '15k-18k' })
    expect(findBankAnswer('期望薪资', profile.answerBank)?.answer).toBe('15k-18k')
  })
  it('开放题 → 起草并标 draft_needs_confirm，带用到的经历', async () => {
    const llm = draftLLM({ '为什么选择我们': '我在 A 公司做过推荐系统重构……' })
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '为什么选择我们', type: 'textarea', maxLength: 500 }] })
    const [p] = await interpretForm(llm, fields, profile, { job: { title: '算法实习生' } })
    expect(p.status).toBe('draft_needs_confirm'); expect(p.source).toBe('draft')
    expect(p.value).toContain('推荐系统'); expect(p.experiencesUsed).toContain('推荐系统重构')
    expect(llm.calls[0].system).toContain('不得编造')
  })
  it('已确认的草稿直接复用；模型失败则 needs_user', async () => {
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '自我评价', type: 'textarea' }, { label: '职业规划', type: 'textarea' }] })
    const plans = await interpretForm(new FakeLLM(['not json at all']), fields, profile, { confirmedDrafts: { '自我评价': '已确认文本' } })
    expect(plans[0]).toMatchObject({ status: 'fill', source: 'draft', value: '已确认文本' })
    expect(plans[1].status).toBe('needs_user')
  })
  it('资料缺的必填项 → needs_user，非必填 → skip；适配器别名生效', async () => {
    const fields = await fieldsOf({ url: 'u', fields: [{ label: '政治面貌', required: true }, { label: '微信', required: false }, { label: '期望工作城市', type: 'select', options: ['北京', '上海'] }] })
    const plans = await interpretForm(noLLM(), fields, profile, { adapter: beisen })
    expect(plans[0].status).toBe('needs_user'); expect(plans[1].status).toBe('skip')
    expect(plans[2]).toMatchObject({ status: 'fill', value: '上海' })
  })
})
