import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { FakePage, extractFields, interpretForm, findBankAnswer, beisen, noneExperiencePlan } from '../src/index.js'
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
  it('答案库只认同一个问题：括号补充、虚词不影响；多出「类型 / 联系人」这种改变意思的词不算（2026-10-31 小鹏「学历」被填成学历类型的答案）', () => {
    const bank = [
      { question_key: '学历类型', answer: '统招全日制', high_impact: false, confirmed: true },
      { question_key: '姓名', answer: '林知远', high_impact: false, confirmed: true },
      { question_key: '国籍（地区）', answer: '中国', high_impact: false, confirmed: true },
    ]
    expect(findBankAnswer('学历', bank)).toBeNull()
    expect(findBankAnswer('紧急联系人姓名', bank)).toBeNull()
    expect(findBankAnswer('学历类型', bank)?.answer).toBe('统招全日制')
    expect(findBankAnswer('请选择学历类型', bank)?.answer).toBe('统招全日制')
    expect(findBankAnswer('国籍', bank)?.answer).toBe('中国')
    expect(findBankAnswer('你的期望薪资是多少', profile.answerBank)?.answer).toBe('15k-18k')
  })
  it('「没有工作经历」这类勾选框按资料定：有实习就不勾（展开后按行填），没有才勾；项目同理（2026-10-31 小鹏默认勾着，实习整段没填）', () => {
    expect(noneExperiencePlan('没有工作经历', profile)).toMatchObject({ status: 'fill', value: 'false' })
    expect(noneExperiencePlan('暂无实习经历', { ...profile, experiences: [] })).toMatchObject({ status: 'fill', value: 'true' })
    expect(noneExperiencePlan('无项目经验', { ...profile, experiences: [{ title: '课设', org: '课程项目', claims: [] }] })).toMatchObject({ value: 'false' })
    expect(noneExperiencePlan('我已阅读并同意隐私协议', profile)).toBeNull()
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
