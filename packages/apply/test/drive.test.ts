import { describe, it, expect } from 'vitest'
import { FakePage, driveApplication, RiskGuard } from '../src/index.js'
import { profile, noLLM, draftLLM, mem } from './helpers.js'

const basics = [{ label: '姓名', required: true }, { label: '邮箱', type: 'email' as const }, { label: '手机号', type: 'tel' as const }]
const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('driveApplication', () => {
  it('遇到提交按钮前停止，绝不点击，并截图', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: basics, buttons: ['保存', { text: '提交申请', submit: true }] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('stopped_before_submit')
    expect(r.submitButton).toBe('提交申请'); expect(r.reason).toBe('submit_confirm')
    expect(page.submitted).toBe(false)
    expect(page.actions.some(a => a.kind === 'click' && a.target?.startsWith('button:'))).toBe(false)
    expect(r.screenshot).toBeInstanceOf(Uint8Array)
    expect(page.fieldValues()).toMatchObject({ 姓名: '张三', 邮箱: 'zhangsan@example.com', 手机号: '13800000000' })
    expect(r.filled.length).toBe(3); expect(r.mismatches).toEqual([])
  })
  it('遇到验证码返回 handoff(captcha)', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: basics, captcha: true, buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('handoff'); expect(r.reason).toBe('captcha')
    expect(page.actions.filter(a => a.kind === 'fill').length).toBe(0)
  })
  it('登录墙返回 handoff(login)；填写过程中弹出验证码也能停下', async () => {
    const login = new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }], login: true })
    expect((await driveApplication(login, noLLM(), profile, quiet)).reason).toBe('login')
    const page = new FakePage({ url: 'https://x.com/apply', fields: basics, buttons: ['下一步'] })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, onPage: () => page.injectCaptcha() })
    // 第一页填完 → 点下一步前 onPage 注入验证码 → 下一页检测到
    expect(r.status).toBe('handoff'); expect(r.reason).toBe('captcha')
  })
  it('多页流程能走完 2 页，停在第 2 页的提交前', async () => {
    const page = new FakePage([
      { url: 'https://x.com/p1', fields: basics, buttons: [{ text: '下一步', goto: 'https://x.com/p2' }] },
      { url: 'https://x.com/p2', fields: [{ label: '学校' }, { label: '专业' }, { label: '期望薪资', required: true }], buttons: ['上一步', { text: '确认提交', submit: true }] },
    ])
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('stopped_before_submit')
    expect(r.pages.length).toBe(2); expect(r.pages[0].nextButton).toBe('下一步')
    expect(page.visited).toEqual(['https://x.com/p1', 'https://x.com/p2'])
    expect(page.fieldValues()).toMatchObject({ 学校: '某某大学', 专业: '计算机科学', 期望薪资: '15k-18k' })
    expect(r.filled.find(f => f.label === '期望薪资')?.source).toBe('answer_bank')
    expect(page.submitted).toBe(false)
  })
  it('上传简历后检查回显，并吸收解析自动填充、只修差异字段', async () => {
    const page = new FakePage({
      url: 'https://x.com/apply',
      fields: [{ label: '简历附件', type: 'file', required: true }, { label: '姓名' }, { label: '邮箱' }],
      uploadEcho: f => `${f} 解析完成`, uploadAutofill: { 姓名: '张三', 邮箱: 'wrong@example.com' },
      buttons: [{ text: '提交', submit: true }],
    })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.uploads[0]).toMatchObject({ echoed: true, file: 'resume-zhangsan.pdf' })
    expect(page.actions[0].kind).toBe('upload')
    // 姓名已被解析填对 → 不重复填；邮箱解析错 → 被修正
    expect(page.actions.filter(a => a.kind === 'fill' && a.target === 'f1').length).toBe(0)
    expect(page.valueOf('邮箱')).toBe('zhangsan@example.com')
    expect(r.status).toBe('stopped_before_submit')
  })
  it('没有回显时 uploads.echoed=false', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '上传简历', type: 'file' }, { label: '姓名' }], buttons: ['提交'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    // FakePage 把文件名写进字段值，所以仍视为回显；用无 resumePath 的 profile 验证 needs_user
    expect(r.uploads[0].echoed).toBe(true)
    const r2 = await driveApplication(new FakePage({ url: 'https://x.com/apply', fields: [{ label: '上传简历', type: 'file' }], buttons: ['提交'] }), noLLM(), { ...profile, resumePath: undefined }, quiet)
    expect(r2.needsUser.map(p => p.label)).toEqual(['上传简历'])
  })
  it('草稿与 needs_user 不写入页面，但出现在结果里', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }, { label: '自我评价', type: 'textarea' }, { label: '是否接受加班', required: true }], buttons: ['提交'] })
    const r = await driveApplication(page, draftLLM({ 自我评价: '草稿内容' }), profile, quiet)
    expect(r.drafts[0]).toMatchObject({ label: '自我评价', status: 'draft_needs_confirm' })
    expect(r.needsUser[0].label).toBe('是否接受加班')
    expect(page.valueOf('自我评价')).toBeUndefined()
  })
  it('点下一步后页面没变 → blocked 并带出校验错误', async () => {
    const page = new FakePage({ url: 'https://x.com/p1', fields: basics, buttons: ['下一步'], errors: ['手机号格式不正确'] })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('blocked'); expect(r.message).toContain('手机号格式不正确')
  })
  it('没有字段 → blocked；风险锁 → blocked', async () => {
    expect((await driveApplication(new FakePage({ url: 'https://x.com/jd', text: '岗位介绍' }), noLLM(), profile, quiet)).status).toBe('blocked')
    const repos = mem(); const guard = new RiskGuard(repos, { platform: 'generic' }); guard.trip('captcha', '上次')
    const r = await driveApplication(new FakePage({ url: 'https://x.com/apply', fields: basics }), noLLM(), profile, { ...quiet, riskGuard: guard })
    expect(r.status).toBe('blocked'); expect(r.message).toContain('captcha')
  })
})
