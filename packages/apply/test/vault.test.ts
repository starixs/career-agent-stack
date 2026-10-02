import { describe, it, expect } from 'vitest'
import { Db, Repos, Vault, StaticKeyProvider } from '@career/core'
import { ApplyService, FakePage, RiskGuard, driveApplication, pickLoginFields, fillLoginForm, normalizeField } from '../src/index.js'
import { profile, noLLM, draftLLM } from './helpers.js'

const KEY = Buffer.alloc(32, 3)
function seeded() {
  const db = new Db(':memory:'); db.migrate()
  const repos = new Repos(db)
  const vault = new Vault(db, new StaticKeyProvider(KEY))
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法实习生', company_name: 'B 公司', url: 'https://x.com/apply' })
  const app = repos.createApplication(job.id)
  repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved')
  return { repos, vault, app }
}
const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const f = (spec: Parameters<typeof normalizeField>[0]) => normalizeField(spec)

describe('登录页代填（不经过模型，不点登录）', () => {
  it('pickLoginFields 按关键词找账号 / 密码框，跳过验证码框', () => {
    const fields = [
      f({ id: 'a', label: '手机号', type: 'tel', required: true }),
      f({ id: 'b', label: '短信验证码', type: 'text', required: true }),
      f({ id: 'c', label: '', name: 'password', type: 'text', required: true, placeholder: '请输入密码' }),
    ]
    const r = pickLoginFields(fields)
    expect(r.username?.id).toBe('a'); expect(r.password?.id).toBe('c')
  })
  it('fillLoginForm 只填账号密码，验证码登录页只填账号并说明', async () => {
    const page = new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }, { label: '密码', name: 'pwd' }], login: true })
    const r = await fillLoginForm(page, { username: 'me@x.com', password: 'p@ss' })
    expect(r.filled).toEqual(['username', 'password'])
    expect(page.valueOf('账号')).toBe('me@x.com'); expect(page.valueOf('密码')).toBe('p@ss')
    expect(page.actions.filter(a => a.kind === 'click').length).toBe(0)
    const sms = new FakePage({ url: 'https://x.com/login', fields: [{ label: '手机号', type: 'tel' }, { label: '验证码' }], login: true })
    const r2 = await fillLoginForm(sms, { username: '138', password: 'x' })
    expect(r2.filled).toEqual(['username']); expect(r2.skipped[0]).toContain('密码')
    expect(sms.valueOf('验证码')).toBeUndefined()
  })
  it('drive 遇到登录墙：有凭证就代填后 handoff(login)，没有凭证直接 handoff', async () => {
    const page = new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }, { label: '密码' }], login: true })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, loginFill: () => ({ username: 'u', password: 'p' }) })
    expect(r.status).toBe('handoff'); expect(r.reason).toBe('login'); expect(r.loginFilled).toEqual(['username', 'password'])
    expect(r.message).toContain('已代填')
    expect(page.submitted).toBe(false)
    const r2 = await driveApplication(new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }], login: true }), noLLM(), profile, { ...quiet, loginFill: () => undefined })
    expect(r2.reason).toBe('login'); expect(r2.loginFilled).toBeUndefined()
  })
})

describe('ApplyService + 私密库', () => {
  it('buildProfile 的 basics 来自私密库并覆盖 kv', () => {
    const { repos, vault } = seeded()
    repos.kvSet('profile.basics', { name: '旧名字', school: 'kv 大学' })
    vault.set({ scope: 'profile', field: 'name', value: '张三' })
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' })
    const p = new ApplyService(repos, noLLM(), { vault }).buildProfile()
    expect(p.basics).toMatchObject({ name: '张三', phone: '13800138000', school: 'kv 大学' })
    expect(vault.accessLog()[0].actor).toBe('form_fill')
  })
  it('页面填的是明文，落库与返回摘要里只有占位符', async () => {
    const { repos, vault, app } = seeded()
    vault.set({ scope: 'profile', field: 'name', value: '张三' })
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' })
    vault.set({ scope: 'profile', field: 'school', value: '某某大学' })
    const svc = new ApplyService(repos, noLLM(), { vault })
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }, { label: '手机号' }, { label: '学校' }], buttons: [{ text: '提交', submit: true }] })
    const out = await svc.run(page, app.id, svc.buildProfile(), quiet)
    expect(out.result.status).toBe('stopped_before_submit')
    expect(page.valueOf('姓名')).toBe('张三'); expect(page.valueOf('手机号')).toBe('13800138000')
    const s = JSON.stringify(out.summary)
    expect(s).not.toContain('张三'); expect(s).not.toContain('13800138000'); expect(s).toContain('某某大学')
    expect(out.summary.filled.find(x => x.label === '手机号')?.value).toBe('{{vault:profile.phone}}')
    expect(JSON.parse(out.application.answers_used_json)).toMatchObject({ 姓名: '{{vault:profile.name}}', 学校: '某某大学' })
    expect(JSON.stringify(repos.getAction(out.action.id)!.result_json)).not.toContain('13800138000')
  })
  it('模型草稿里的占位符在填写时解成明文；起草提示词里没有姓名', async () => {
    const { repos, vault, app } = seeded()
    vault.set({ scope: 'profile', field: 'name', value: '张三' })
    vault.set({ scope: 'profile', field: 'email', value: 'zs@example.com' })
    const llm = draftLLM({ 自我介绍: '我是{{vault:profile.name}}，邮箱 {{vault:profile.email}}' })
    const svc = new ApplyService(repos, llm, { vault })
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '自我介绍', type: 'textarea' }], buttons: ['提交'] })
    const out = await svc.run(page, app.id, svc.buildProfile(), { ...quiet, interpret: { confirmedDrafts: { 自我介绍: '我是{{vault:profile.name}}，邮箱 {{vault:profile.email}}' } } })
    expect(page.valueOf('自我介绍')).toBe('我是张三，邮箱 zs@example.com')
    expect(out.summary.filled[0].value).toBe('我是{{vault:profile.name}}，邮箱 {{vault:profile.email}}')
    // 没有已确认草稿时走模型起草：提示词里不能有姓名明文
    const llm2 = draftLLM({ 自我介绍: '草稿' })
    const svc2 = new ApplyService(repos, llm2, { vault })
    await svc2.run(new FakePage({ url: 'https://x.com/apply', fields: [{ label: '自我介绍', type: 'textarea' }], buttons: ['提交'] }), app.id, svc2.buildProfile(), quiet)
    expect(llm2.calls[0].messages[0].content).not.toContain('张三')
  })
  it('登录墙 + 私密库站点账号：只有开了 autofill 才代填', async () => {
    const { repos, vault, app } = seeded()
    vault.set({ scope: 'site', ref_id: 'x.com', field: 'username', value: 'zhangsan2026' })
    vault.set({ scope: 'site', ref_id: 'x.com', field: 'password', value: 'Pw#2026xyz' })
    const svc = new ApplyService(repos, noLLM(), { vault })
    const page = new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }, { label: '密码' }], login: true })
    let out = await svc.run(page, app.id, svc.buildProfile(), quiet)
    expect(out.handoff?.reason).toBe('login'); expect(page.valueOf('账号')).toBeUndefined()
    const u = vault.list('site', 'x.com').find(i => i.field === 'username')!
    vault.setPolicy(u.id, { autofill: true })
    new RiskGuard(repos, { platform: out.result.adapterId }).clear() // 上一次登录墙上了风险锁
    const page2 = new FakePage({ url: 'https://x.com/login', fields: [{ label: '账号' }, { label: '密码' }], login: true })
    out = await svc.run(page2, app.id, svc.buildProfile(), quiet)
    expect(out.handoff?.reason).toBe('login'); expect(page2.valueOf('账号')).toBe('zhangsan2026'); expect(page2.valueOf('密码')).toBe('Pw#2026xyz')
    expect(out.summary.loginFilled).toEqual(['username', 'password'])
    expect(JSON.stringify(out.summary)).not.toMatch(/zhangsan2026|Pw#2026xyz/)
  })
})
