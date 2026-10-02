import { describe, it, expect } from 'vitest'
import { ApplyService, FakePage } from '../src/index.js'
import { mem, profile, noLLM } from './helpers.js'

function seeded() {
  const repos = mem()
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法实习生', company_name: 'B 公司', url: 'https://x.com/apply' })
  const app = repos.createApplication(job.id)
  repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved')
  return { repos, app }
}
const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('ApplyService', () => {
  it('停在提交前：fill_form 记录 done，submit 进 pending_review，application 停在 pending 等审核', async () => {
    const { repos, app } = seeded()
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }, { label: '邮箱' }], buttons: [{ text: '提交', submit: true }] })
    const out = await new ApplyService(repos, noLLM()).run(page, app.id, profile, quiet)
    expect(out.result.status).toBe('stopped_before_submit')
    expect(out.action).toMatchObject({ kind: 'fill_form', status: 'done' })
    expect(out.submitAction).toMatchObject({ kind: 'submit', status: 'pending_review', application_id: app.id })
    expect(repos.listActions('pending_review').map(a => a.kind)).toEqual(['submit'])
    expect(out.application.stage).toBe('pending')
    expect(out.application.next_action).toBe('审核后提交')
    expect(JSON.parse(out.application.answers_used_json)).toMatchObject({ 姓名: '张三' })
    expect(page.submitted).toBe(false)
    const hist = repos.db.all<{ to_stage: string }>('SELECT to_stage FROM application_history WHERE application_id=? ORDER BY created_at', [app.id]).map(h => h.to_stage)
    expect(hist).toEqual(['evaluated', 'ready', 'approved', 'pending'])
  })
  it('缺高影响答案：submit 仍进待审核，但 application → needs_user 并开 handoff(missing_info)', async () => {
    const { repos, app } = seeded()
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }, { label: '是否需要签证', required: true }], buttons: ['提交'] })
    const out = await new ApplyService(repos, noLLM()).run(page, app.id, { ...profile, answerBank: [] }, quiet)
    expect(out.submitAction?.status).toBe('pending_review')
    expect(out.application.stage).toBe('needs_user')
    expect(out.handoff).toMatchObject({ reason: 'missing_info', action_id: out.submitAction!.id })
    expect(out.application.blocker_reason).toContain('签证')
  })
  it('验证码：handoff(captcha)，fill_form needs_user，application → needs_user', async () => {
    const { repos, app } = seeded()
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }], captcha: true })
    const out = await new ApplyService(repos, noLLM()).run(page, app.id, profile, quiet)
    expect(out.handoff?.reason).toBe('captcha')
    expect(out.action.status).toBe('needs_user')
    expect(out.application.stage).toBe('needs_user')
    expect(repos.openHandoffs().length).toBe(1)
    expect(repos.listActions('pending_review').length).toBe(0)
  })
  it('没有表单：blocked，不产生 submit 动作；blocked 可再次开跑', async () => {
    const { repos, app } = seeded()
    const svc = new ApplyService(repos, noLLM())
    const out = await svc.run(new FakePage({ url: 'https://x.com/jd', text: '职位介绍' }), app.id, profile, quiet)
    expect(out.application.stage).toBe('blocked'); expect(out.action.status).toBe('failed'); expect(out.submitAction).toBeUndefined()
    const again = await svc.run(new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }], buttons: ['提交'] }), app.id, profile, quiet)
    expect(again.application.stage).toBe('pending')
  })
  it('buildProfile 从 Repos 组装资料', () => {
    const { repos } = seeded()
    repos.kvSet('profile.basics', { name: '李四' })
    const e = repos.createExperience({ title: '项目 X' }); repos.addClaim({ experience_id: e.id, text: '待核实' }); const c = repos.addClaim({ experience_id: e.id, text: '已确认' }); repos.confirmClaim(c.id)
    repos.saveAnswer({ question_key: '期望薪资', question_text: '期望薪资', answer: '10k', high_impact: true, confirmed: true })
    const p = new ApplyService(repos, noLLM()).buildProfile('/tmp/r.pdf')
    expect(p.basics.name).toBe('李四'); expect(p.experiences[0].claims).toEqual(['已确认']); expect(p.answerBank[0]).toMatchObject({ answer: '10k', high_impact: true })
  })
})
