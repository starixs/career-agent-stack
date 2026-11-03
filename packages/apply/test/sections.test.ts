import { describe, it, expect } from 'vitest'
import { FakePage, driveApplication, entriesFor, findAddButton, groupRows, matchRowField, normalizeField, SECTIONS, splitPeriod, type Profile } from '../src/index.js'
import { profile, noLLM, draftLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const edu = SECTIONS.find(s => s.key === 'education')!
const exp = SECTIONS.find(s => s.key === 'experience')!
const f = (id: string, label: string, value?: string) => normalizeField({ id, label, type: 'text', required: false, value })

describe('重复分区（表格）', () => {
  it('行内字段匹配与按锚字段切行', () => {
    expect(matchRowField('学校名称', edu)).toBe('school')
    expect(matchRowField('入学时间', edu)).toBe('start')
    expect(matchRowField('公司名称', exp)).toBe('org')
    expect(matchRowField('姓名', edu)).toBeNull()
    const rows = groupRows([f('a', '姓名'), f('b', '学校名称'), f('c', '专业'), f('d', '学历'), f('e', '学校名称'), f('f', '专业')], edu)
    expect(rows.map(r => r.map(x => x.key))).toEqual([['school', 'major', 'degree'], ['school', 'major']])
  })
  it('起止范围控件：同一个标签的两个输入框，先出现的是开始、后出现的是结束（2026-10-31 小鹏两格都填成了毕业时间）', () => {
    const rows = groupRows([f('a', '学校名称'), f('b', '学历'), f('c', '起止时间'), f('d', '起止时间'), f('e', '学校名称'), f('f', '起止时间'), f('g', '起止时间')], edu)
    expect(rows.map(r => r.map(x => `${x.field.id}:${x.key}`))).toEqual([['a:school', 'b:degree', 'c:start', 'd:end'], ['e:school', 'f:start', 'g:end']])
    const work = groupRows([f('a', '公司名称'), f('b', '实习时间'), f('c', '实习时间')], exp)
    expect(work[0].map(x => x.key)).toEqual(['org', 'start', 'end'])
  })
  it('条目来源：education 优先，否则由基本信息拼一段；实习与项目按 org 区分', () => {
    const p: Profile = { ...profile, education: [{ school: 'A 大学', major: '计算机', degree: '本科', start: '2021.09', end: '2025.06' }, { school: 'B 大学', major: '软件工程', degree: '硕士' }] }
    expect(entriesFor('education', p).map(e => e.school)).toEqual(['A 大学', 'B 大学'])
    expect(entriesFor('education', profile)).toEqual([{ school: '某某大学', major: '计算机科学', degree: '本科', end: '2026-06' }])
    expect(entriesFor('experience', profile)).toEqual([{ org: 'A 公司', role: '算法实习生', start: '2025.03', end: '2025.08', description: '把离线特征计算从 6h 压到 40min' }])
    expect(entriesFor('project', profile)).toEqual([{ name: '校园二手平台', role: '后端', start: undefined, end: undefined, description: '独立实现订单与支付模块' }])
  })
  it('实习 / 工作分区只用实习工作：校园经历（社团、竞赛队）不进去；有类别按类别，没有按机构名推断（2026-10-31 小鹏填进了「校 ACM 集训队」）', () => {
    const p: Profile = { ...profile, experiences: [
      { title: 'ACM', org: '校 ACM 集训队', role: '成员', claims: [] },
      { title: '实习', org: '上海某电商科技公司', role: '后端开发实习生', period: '2026-06~2026-09', claims: ['订单服务重构'] },
      { title: '学生会', org: '计算机学院学生会技术部', role: '副部长', claims: [], kind: 'work' },
      { title: '二手平台', org: '', role: '后端', claims: [], kind: 'project' },
      { title: '社团', org: '摄影协会', claims: [], kind: 'campus' },
    ] }
    expect(entriesFor('experience', p).map(e => e.org)).toEqual(['上海某电商科技公司', '计算机学院学生会技术部'])
    expect(entriesFor('project', p).map(e => e.name)).toEqual(['二手平台'])
  })
  it('找添加按钮：带分区名的优先；多个泛用"添加"时不乱点；提交类永远不算', () => {
    const b = (text: string, i: number) => ({ id: `b${i}`, text, selector: `[data-career-btn="b${i}"]`, disabled: false })
    expect(findAddButton([b('添加教育经历', 0), b('添加工作经历', 1)], edu)?.text).toBe('添加教育经历')
    expect(findAddButton([b('+ 添加', 0)], exp)?.text).toBe('+ 添加')
    // 写明了别的对象的「添加更多志愿」不是教育经历的添加入口（真机：点了它多出一行空的第二志愿）
    expect(findAddButton([b('添加更多志愿', 0)], edu)).toBeUndefined()
    expect(findAddButton([b('添加更多志愿', 0), b('添加教育经历', 1)], edu)?.text).toBe('添加教育经历')
    expect(findAddButton([b('添加一条', 0)], edu)?.text).toBe('添加一条')
    expect(findAddButton([b('添加', 0), b('新增', 1)], exp)).toBeUndefined()
    expect(findAddButton([b('添加并提交', 0)], exp)).toBeUndefined()
  })
  it('drive：教育经历两段 → 第 1 行由基本信息填、点"添加教育经历"后只填新出现的第 2 行', async () => {
    const page = new FakePage({
      url: 'https://x.com/apply',
      fields: [{ label: '姓名' }, { label: '学校名称' }, { label: '专业' }, { label: '学历' }],
      buttons: [{ text: '添加教育经历', addFields: [{ label: '学校名称' }, { label: '专业' }, { label: '学历' }] }, { text: '提交', submit: true }],
    })
    const p: Profile = { ...profile, education: [{ school: 'A 大学', major: '计算机', degree: '本科' }, { school: 'B 大学', major: '软件工程', degree: '硕士' }] }
    const r = await driveApplication(page, noLLM(), p, quiet)
    expect(r.status).toBe('stopped_before_submit')
    expect(page.actions.filter(a => a.kind === 'click' && a.target === 'button:添加教育经历').length).toBe(1)
    const values = page.fieldValues()
    expect(values['姓名']).toBe('张三')
    expect(r.pages[0].sections).toEqual([expect.objectContaining({ key: 'education', entries: 2, rowsBefore: 1, rowsAfter: 2, added: 1 })])
    // 第 2 行的值（FakePage 同名字段后出现的覆盖了 fieldValues 的 key，用 actions 核对）
    const fills = page.actions.filter(a => a.kind === 'fill').map(a => [a.target, a.value])
    expect(fills).toEqual(expect.arrayContaining([['f4', 'B 大学'], ['f5', '软件工程'], ['f6', '硕士']]))
    expect(fills.find(x => x[0] === 'f1')?.[1]).toBe('某某大学') // 第 1 行：基本信息层先填了 basics.school（与 education[0] 不同时不覆盖）
    expect(r.filled.filter(x => x.label === '学校名称').length).toBe(2)
    expect(page.submitted).toBe(false)
  })
  it('drive：没有添加按钮时记录 note，不报错；点了添加没出新行也停止', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '公司名称' }, { label: '职位' }], buttons: ['提交'] })
    const p: Profile = { ...profile, experiences: [{ title: 'A', org: 'A 公司', role: '实习生', claims: [] }, { title: 'B', org: 'B 公司', role: '工程师', claims: [] }] }
    const r = await driveApplication(page, noLLM(), p, quiet)
    expect(page.fieldValues()).toMatchObject({ 公司名称: 'A 公司', 职位: '实习生' })
    expect(r.pages[0].sections?.[0]).toMatchObject({ key: 'experience', entries: 2, rowsAfter: 1, added: 0, note: expect.stringContaining('没有找到') })
    const page2 = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '公司名称' }], buttons: [{ text: '添加工作经历' }, '提交'] })
    const r2 = await driveApplication(page2, noLLM(), p, quiet)
    expect(r2.pages[0].sections?.[0].note).toContain('没有出现新的一行')
    expect(r2.status).toBe('stopped_before_submit')
  })
  it('drive：实习行里的「描述」用这段经历确认过的说法填，不当开放题起草（2026-10-31 小鹏变成了待确认草稿）', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '公司名称' }, { label: '职位' }, { label: '描述', type: 'textarea' }], buttons: ['提交'] })
    const p: Profile = { ...profile, experiences: [{ title: 'A', org: 'A 公司', role: '后端实习生', period: '2026-06~2026-09', claims: ['订单服务重构', '接口延迟降到 50ms'] }] }
    const r = await driveApplication(page, draftLLM({ 描述: '（模型起草的一段话）' }), p, quiet)
    expect(page.fieldValues()).toMatchObject({ 公司名称: 'A 公司', 职位: '后端实习生', 描述: '订单服务重构；接口延迟降到 50ms' })
    expect(r.drafts).toEqual([])
  })
  it('时间段拆分：日期里的短横线不是分隔符；「至今」是结束', () => {
    expect(splitPeriod('2026-06~2026-09')).toEqual({ start: '2026-06', end: '2026-09' })
    expect(splitPeriod('2023.09 - 2027.06')).toEqual({ start: '2023.09', end: '2027.06' })
    expect(splitPeriod('2024年3月至今')).toEqual({ start: '2024年3月', end: '至今' })
    expect(splitPeriod('')).toEqual({})
  })
})
