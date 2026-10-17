import { describe, it, expect } from 'vitest'
import { Db, Repos, canTransition, extractJson, FakeLLM, parseFrontmatter } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('经历库', () => {
  it('经历 → 主张 → 证据 三层可写可读，状态默认待核实', () => {
    const r = mem()
    const e = r.createExperience({ title: '推荐系统重构', type: 'dev' })
    const c = r.addClaim({ experience_id: e.id, text: '把离线特征计算从 6h 压到 40min', attribution: 'self', created_from: 'repo' })
    r.addEvidence({ claim_id: c.id, kind: 'commit', locator: 'abc123', strength: 'strong' })
    const tree = r.experienceTree()
    expect(tree[0].claims[0].status).toBe('pending')
    expect(tree[0].claims[0].evidence[0].kind).toBe('commit')
    r.confirmClaim(c.id)
    expect(r.listClaims(e.id)[0].status).toBe('user_confirmed')
  })
})

describe('投递台状态机', () => {
  it('只允许定义过的流转，并写历史', () => {
    const r = mem()
    const j = r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '数据分析实习生', company_name: 'X' })
    const a = r.createApplication(j.id)
    expect(() => r.transition(a.id, 'applied')).toThrow()
    r.transition(a.id, 'ready'); r.transition(a.id, 'approved'); r.transition(a.id, 'pending'); r.transition(a.id, 'applied', '已提交', { submission_evidence: 'screenshot.png' })
    expect(r.getApplication(a.id)!.stage).toBe('applied')
    expect(r.db.all('SELECT * FROM application_history WHERE application_id=?', [a.id]).length).toBe(5)
    expect(canTransition('offer', 'hired')).toBe(true)
  })
  it('同平台同 job_id 去重更新；跨平台软去重可查', () => {
    const r = mem()
    r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: 'A', company_name: 'C', location: '上海' })
    r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: 'A', company_name: 'C', salary: '10k' })
    expect(r.listJobs().length).toBe(1)
    expect(r.listJobs()[0].salary).toBe('10k')
    expect(r.findDuplicateJob('C', 'A', '上海')).toBeTruthy()
  })
  it('看板给出今天到期、卡住、漏斗', () => {
    const r = mem()
    const j = r.upsertJob({ source_platform: 'campus', title: '管培生', company_name: 'Y', deadline: '2020-01-01' })
    const a = r.createApplication(j.id)
    r.transition(a.id, 'ready'); r.transition(a.id, 'approved'); r.transition(a.id, 'blocked', '验证码', { blocker_reason: 'captcha' })
    const b = r.board('2026-10-02')
    expect(b.due.length).toBe(1); expect(b.blocked.length).toBe(1); expect(b.funnel.find(f => f.stage === 'blocked')!.n).toBe(1)
  })
})

describe('动作队列与接管', () => {
  it('提交与发送永远进待审核，即使要求自动批准', () => {
    const r = mem()
    expect(r.enqueueAction('submit', {}, null, true).status).toBe('pending_review')
    expect(r.enqueueAction('send_greeting', {}, null, true).status).toBe('pending_review')
    expect(r.enqueueAction('fill_form', {}, null, true).status).toBe('approved')
  })
  it('今日队列：没开始的填表不写成「待你批准」（填写本身不提交，不需要事前批准）', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'campus', title: '后端开发', company_name: '美团' })
    const app = r.createApplication(job.id)
    r.enqueueAction('fill_form', { job_id: job.id }, app.id)
    r.enqueueAction('submit', { job_id: job.id }, app.id)
    const titles = r.today().items.filter(i => i.kind === 'review').map(i => i.title)
    expect(titles).toContain('待投清单：还没开始填 · 美团 后端开发')
    expect(titles).toContain('待你批准：提交网申 · 美团 后端开发')
    expect(titles.some(t => t.includes('待你批准：网申填表'))).toBe(false)
  })
  it('批量审核与接管开闭', () => {
    const r = mem()
    const a1 = r.enqueueAction('fill_form', {}); const a2 = r.enqueueAction('upload', {})
    expect(r.reviewActions([a1.id, a2.id], 'approved')).toBe(2)
    const t = r.createTask({ title: '投递', kind: 'apply' })
    const h = r.openHandoff('captcha', { actionId: a1.id, taskId: t.id })
    expect(r.getTask(t.id)!.status).toBe('needs_user'); expect(r.getAction(a1.id)!.status).toBe('needs_user')
    r.closeHandoff(h.id, 'step-3')
    expect(r.getTask(t.id)!.status).toBe('running'); expect(r.openHandoffs().length).toBe(0)
  })
})

describe('工具', () => {
  it('extractJson 容忍代码块与噪声', () => {
    expect(extractJson('好的：```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] })
    expect(extractJson('前言 {"x":"}"} 后记')).toEqual({ x: '}' })
  })
  it('FakeLLM 与 frontmatter', async () => {
    const llm = new FakeLLM(['hi'])
    expect((await llm.complete({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('hi')
    expect(parseFrontmatter('---\nname: a\ndescription: b\n---\nbody').meta.name).toBe('a')
  })
})

describe('今天做过', () => {
  it('汇总任务进展和投递阶段变化，新的在前，只看起点之后', () => {
    const r = mem()
    const j = r.upsertJob({ source_platform: 'campus', title: '产品经理', company_name: '星河科技' })
    const a = r.createApplication(j.id)
    r.db.run(`UPDATE application_history SET created_at='2020-01-01T00:00:00.000Z'`)
    r.transition(a.id, 'ready', '材料齐了')
    const t = r.createTask({ title: '填写星河科技网申', kind: 'apply' })
    r.updateTask(t.id, { status: 'running', step: '在填教育经历' })
    const entries = r.activitySince('2021-01-01T00:00:00.000Z')
    expect(entries.map(e => e.kind).sort()).toEqual(['stage', 'task'])
    const stage = entries.find(e => e.kind === 'stage')!
    expect(stage).toMatchObject({ status: 'ready', title: '星河科技 产品经理', detail: '材料齐了' })
    expect(entries.find(e => e.kind === 'task')).toMatchObject({ title: '填写星河科技网申', status: 'running', detail: '在填教育经历' })
    expect(r.activitySince('2999-01-01T00:00:00.000Z')).toEqual([])
  })
})
