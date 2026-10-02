import { describe, it, expect } from 'vitest'
import { Db, Repos, classifyJobTitle, weekStartOf, silenceOf, funnelBy, shortestStagePath, ACTIONS_REQUIRING_REVIEW } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }
const NOW = '2026-10-03T08:00:00.000Z'

describe('纯函数', () => {
  it('岗位标题归类到代理反馈的分组', () => {
    expect(classifyJobTitle('数据分析实习生')).toBe('算法与数据')
    expect(classifyJobTitle('Java 后端开发工程师')).toBe('开发')
    expect(classifyJobTitle('产品经理（校招）')).toBe('产品')
    expect(classifyJobTitle('管培生')).toBe('职能')
    expect(classifyJobTitle('')).toBe('其他')
  })
  it('周起点是周一；静默按阶段阈值判定', () => {
    expect(weekStartOf('2026-10-03')).toBe('2026-09-28')
    expect(weekStartOf('2026-09-28T10:00:00Z')).toBe('2026-09-28')
    expect(silenceOf('applied', '2026-09-01T00:00:00Z', NOW)).toMatchObject({ silent: true, days: 32, threshold: 21 })
    expect(silenceOf('applied', '2026-09-20T00:00:00Z', NOW).silent).toBe(false)
    expect(silenceOf('evaluated', '2026-01-01T00:00:00Z', NOW)).toMatchObject({ silent: false, threshold: null })
  })
  it('漏斗按 key 聚合各环节人数与静默数', () => {
    const rows = [
      { stage: 'applied', updated_at: '2026-09-01T00:00:00Z', job: { title: 'A', company_name: 'X', source_platform: 'boss' } },
      { stage: 'interview', updated_at: NOW, job: { title: 'B', company_name: 'Y', source_platform: 'boss' } },
      { stage: 'rejected', updated_at: NOW, job: { title: 'C', company_name: 'Z', source_platform: 'campus' } },
    ] as never
    const f = funnelBy(rows, r => r.job.source_platform, NOW)
    expect(f[0]).toMatchObject({ key: 'boss', total: 2, applied: 2, responded: 1, interview: 1, offer: 0, silent: 1 })
    expect(f[1]).toMatchObject({ key: 'campus', total: 1, rejected: 1 })
  })
})

describe('收件箱 / 截止 / 今日队列', () => {
  it('收件箱条目从 new 到 processed，并关联对象', () => {
    const r = mem()
    const item = r.createInboxItem({ source: 'paste', raw_text: '诚邀您参加 10 月 5 日 14:00 的一面' })
    expect(item.status).toBe('new')
    const job = r.upsertJob({ source_platform: 'manual', title: '产品实习生', company_name: '某司' })
    const done = r.resolveInboxItem(item.id, { kind: 'interview_invite', parsed: { when: '2026-10-05T06:00:00Z' }, linked_type: 'job', linked_id: job.id })
    expect(done.status).toBe('processed')
    expect(done.kind).toBe('interview_invite')
    expect(JSON.parse(done.parsed_json!).when).toBe('2026-10-05T06:00:00Z')
    expect(r.listInbox('new')).toHaveLength(0)
    expect(r.dismissInboxItem(r.createInboxItem({ raw_text: '广告' }).id).status).toBe('dismissed')
  })

  it('今日队列：过期在前，其次今天到期、待审、静默；过期事件被标 missed', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'boss', source_job_id: 'j1', title: '数据分析实习生', company_name: '甲公司' })
    const app = r.createApplication(job.id)
    r.transition(app.id, 'ready'); r.transition(app.id, 'approved'); r.transition(app.id, 'pending'); r.transition(app.id, 'applied')
    // 把 updated_at 拨回 30 天前制造静默
    r.db.update('application', app.id, { updated_at: '2026-09-01T00:00:00Z' })
    r.createDeadline({ kind: 'assessment', title: '乙公司测评', due_at: '2026-10-02T10:00:00Z' })
    r.createDeadline({ kind: 'written_test', title: '丙公司笔试', due_at: '2026-10-03T12:00:00Z', application_id: app.id })
    r.createDeadline({ kind: 'offer_reply', title: '丁公司 offer 回复', due_at: '2026-10-20T00:00:00Z' })
    r.enqueueAction('submit', { job_id: job.id }, app.id)
    r.createInboxItem({ raw_text: '新邮件' })

    const today = r.today(NOW)
    expect(today.items.map(i => i.kind)).toEqual(['deadline', 'deadline', 'review', 'inbox', 'stale'])
    expect(today.items[0].title).toBe('乙公司测评')
    expect(today.items[0].detail).toContain('已过期')
    expect(today.items[1].detail).toContain('今天')
    expect(today.items[4].suggest).toContain(app.id)
    expect(today.waiting).toEqual({ count: 1, by_stage: [{ stage: 'applied', n: 1 }] })
    expect(today.pending_review).toBe(1)
    expect(today.inbox_new).toBe(1)
    expect(r.listDeadlines({ status: 'missed' }).map(d => d.title)).toEqual(['乙公司测评'])
    // 20 天后的事件不进今日
    expect(today.items.some(i => i.title.includes('丁公司'))).toBe(false)
  })
})

describe('状态机跳转', () => {
  it('jumpTo 沿最短合法路径推进并写历史；不可达时抛错', () => {
    expect(shortestStagePath('evaluated', 'interview')).toEqual(['ready', 'approved', 'applied', 'interview'])
    expect(shortestStagePath('rejected', 'offer')).toBeNull()
    const r = mem()
    const job = r.upsertJob({ source_platform: 'manual', title: 'X', company_name: 'Y' })
    const app = r.createApplication(job.id)
    expect(r.jumpTo(app.id, 'interview', '收到面试邀请').stage).toBe('interview')
    expect(r.db.all('SELECT * FROM application_history WHERE application_id=?', [app.id]).length).toBe(5)
    expect(() => r.jumpTo(app.id, 'evaluated')).toThrow()
  })
})

describe('卷宗 / 素材 / 复盘 / 邮箱', () => {
  it('卷宗笔记与素材使用记录都能按投递与公司查回', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'manual', title: '运营实习生', company_name: '乙公司' })
    const app = r.createApplication(job.id)
    r.addDossierNote({ application_id: app.id, kind: 'said', round: 'hr', content: '实习可以每周 4 天' })
    expect(r.listDossierNotes(app.id)[0].content).toContain('4 天')
    const m = r.createMaterial({ kind: 'why_company', title: '为什么选择我们', content: '因为……', claim_ids: ['clm_1'] })
    r.recordMaterialUse({ material_id: m.id, application_id: app.id, context: '网申', content_snapshot: '因为……' })
    expect(r.listMaterialUses({ company_name: '乙公司' })).toHaveLength(1)
    expect(r.listMaterialUses({ application_id: app.id })[0].material_id).toBe(m.id)
    expect(r.updateMaterial(m.id, { confirmed: true, tags: ['校招'] }).confirmed).toBe(1)
    expect(r.listMaterials({ kind: 'why_company' })).toHaveLength(1)
    expect(r.findOpenApplicationsByCompany('乙公司')).toHaveLength(1)
    expect(r.findOpenApplicationsByCompany('不存在')).toHaveLength(0)
  })
  it('漏斗与周复盘可保存读取', () => {
    const r = mem()
    const j1 = r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '后端开发', company_name: 'A' })
    const j2 = r.upsertJob({ source_platform: 'campus', source_job_id: '2', title: '产品经理', company_name: 'B' })
    r.createApplication(j1.id); r.createApplication(j2.id)
    const f = r.funnel(NOW)
    expect(f.overall?.total).toBe(2)
    expect(f.by_category.map(x => x.key).sort()).toEqual(['产品', '开发'])
    const w = r.saveWeeklyReview({ week_start: '2026-09-28', funnel: f, insights: ['投得少'], small_action: '今天投 2 个' })
    expect(r.listWeeklyReviews()[0].id).toBe(w.id)
  })
  it('邮件账号唯一按地址 upsert；同 uid 邮件只存一次；发邮件必须过审', () => {
    const r = mem()
    const a = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com', display_name: '我' })
    expect(r.listMailAccounts()).toHaveLength(1)
    expect(r.getMailAccount(a.id)!.display_name).toBe('我')
    const base = { account_id: a.id, uid: 7, message_id: '<x@y>', in_reply_to: null, direction: 'in' as const, from_addr: 'hr@a.com', to_addr: 'me@qq.com', subject: '面试邀请', snippet: null, body_text: null, received_at: NOW, relevance: 'unknown' as const, kind: null, inbox_item_id: null, application_id: null, action_id: null }
    expect(r.insertMailMessage(base)).toBeTruthy()
    expect(r.insertMailMessage(base)).toBeNull()
    expect(r.findMailByMessageId('<x@y>')!.subject).toBe('面试邀请')
    expect(ACTIONS_REQUIRING_REVIEW).toContain('send_mail')
    expect(r.enqueueAction('send_mail', {}, null, true).status).toBe('pending_review')
  })
})
