import { describe, it, expect } from 'vitest'
import { SiteMemory, fieldSignatures, normalizeHost, driveApplication, FakePage } from '../src/index.js'
import { mem, profile, noLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('站点映射记忆', () => {
  it('签名按 name > xpath > 标签；记住后按任一签名都能回忆；用户纠正不被别名覆盖', () => {
    const repos = mem()
    const m = new SiteMemory(repos)
    expect(fieldSignatures({ name: 'applicant_mobile', xpath: '/html/body/input[2]', label: '联系方式' })).toEqual(['name:applicant_mobile', 'xpath:/html/body/input[2]', 'label:联系方式'])
    expect(fieldSignatures({ name: '123', label: '' })).toEqual([])
    m.remember('https://campus.x.com/apply', { name: 'applicant_mobile', label: '联系方式' }, 'phone')
    expect(m.recall('campus.x.com', { name: 'applicant_mobile' })?.key).toBe('phone')
    expect(m.recall('campus.x.com', { label: '联系方式' })).toMatchObject({ key: 'phone', source: 'alias', hits: 1 })
    m.remember('campus.x.com', { name: 'applicant_mobile' }, 'phone')
    expect(m.recall('campus.x.com', { name: 'applicant_mobile' })?.hits).toBe(2)
    m.remember('campus.x.com', { name: 'applicant_mobile' }, 'wechat', 'user')
    m.remember('campus.x.com', { name: 'applicant_mobile' }, 'phone', 'alias')
    expect(m.recall('campus.x.com', { name: 'applicant_mobile' })).toMatchObject({ key: 'wechat', source: 'user' })
    expect(normalizeHost('https://WWW.Campus.x.com/a?b=1')).toBe('campus.x.com')
    m.forget('campus.x.com')
    expect(m.recall('campus.x.com', { name: 'applicant_mobile' })).toBeUndefined()
  })
  it('drive：第一次按别名填并记忆；第二次同站字段标签改成别名认不出的词，靠记忆直填', async () => {
    const repos = mem()
    const memory = new SiteMemory(repos)
    const first = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '手机号', name: 'applicant_mobile' }, { label: '姓名', name: 'applicant_name' }], buttons: ['提交'] })
    const r1 = await driveApplication(first, noLLM(), profile, { ...quiet, siteMemory: memory })
    expect(r1.status).toBe('stopped_before_submit'); expect(r1.memorized).toBe(2)
    expect(memory.recall('x.com', { name: 'applicant_mobile' })?.key).toBe('phone')
    // 第二次：标签换成"联络号码"（别名表没有），name 没变 → 记忆命中
    const second = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '联络号码', name: 'applicant_mobile' }, { label: '姓名', name: 'applicant_name' }], buttons: ['提交'] })
    const r2 = await driveApplication(second, noLLM(), profile, { ...quiet, siteMemory: memory })
    expect(second.valueOf('联络号码')).toBe('13800000000')
    expect(r2.filled.find(f => f.label === '联络号码')?.source).toBe('profile')
    expect(memory.recall('x.com', { name: 'applicant_mobile' })?.hits).toBe(2) // 两次 drive 各记一次
    // 没有记忆的站：认不出的标签仍然 skip
    const other = new FakePage({ url: 'https://y.com/apply', fields: [{ label: '联络号码', name: 'applicant_mobile' }], buttons: ['提交'] })
    const r3 = await driveApplication(other, noLLM(), profile, { ...quiet, siteMemory: memory })
    expect(other.valueOf('联络号码')).toBeUndefined(); expect(r3.filled).toEqual([])
  })
  it('learnFrom：续跑时把用户自己填好的 needs_user 字段回传', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '是否需要签证', value: '不需要' }, { label: '姓名' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), { ...profile, answerBank: [] }, { ...quiet, learnFrom: ['是否需要签证', '期望薪资'] })
    expect(r.learned).toEqual([{ label: '是否需要签证', value: '不需要' }])
  })
})
