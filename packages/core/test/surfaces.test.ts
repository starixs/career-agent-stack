import { describe, it, expect } from 'vitest'
import { Db, Repos, classifyJobTitle, weekStartOf, silenceOf, funnelBy, shortestStagePath, isSendNote, ACTIONS_REQUIRING_REVIEW } from '../src/index.js'

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
    expect(silenceOf('applied', '2026-09-01T00:00:00Z', NOW)).toMatchObject({ silent: true, days: 32, threshold: 30 })
    // 投出 25 天：大厂常要一个月左右，还不算静默
    expect(silenceOf('applied', '2026-09-08T00:00:00Z', NOW).silent).toBe(false)
    expect(silenceOf('interview', '2026-09-17T00:00:00Z', NOW)).toMatchObject({ silent: false, days: 16, threshold: 21 })
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
  it('面试时间过了不算错过：一天内提示复盘、不标红，之后只留在卷宗', () => {
    const r = mem()
    const d = r.createDeadline({ kind: 'interview', title: '百度 · 算法 面试（二面）', due_at: '2026-10-03T06:00:00.000Z', application_id: null })
    expect(r.markMissedDeadlines(NOW)).toBe(0)
    const item = r.today(NOW).items.find(i => i.deadline_id === d.id)
    expect(item).toMatchObject({ kind: 'interview_retro', priority: 4, title: '百度 · 算法（二面） 面完了？' })
    expect(r.today('2026-10-04T07:00:00.000Z').items.find(i => i.deadline_id === d.id)).toBeUndefined()
    expect(r.getDeadline(d.id)!.status).toBe('open')
  })
  it('面试在今日队列里说「几天后」，不说「截止」；测评仍说截止', () => {
    const r = mem()
    r.createDeadline({ kind: 'interview', title: '百度二面', due_at: '2026-10-05T06:00:00.000Z' })
    r.createDeadline({ kind: 'assessment', title: '九方云测评', due_at: '2026-10-05T06:00:00.000Z' })
    const details = Object.fromEntries(r.today(NOW).items.map(i => [i.title, i.detail]))
    expect(details['百度二面']).toBe('2 天后')
    expect(details['九方云测评']).toBe('2 天后截止')
  })
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

  it('今日队列：今天到期在前，其次待审、收件、静默，已过期排在队尾；过期事件被标 missed', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'boss', source_job_id: 'j1', title: '数据分析实习生', company_name: '甲公司' })
    const app = r.createApplication(job.id)
    r.transition(app.id, 'ready'); r.transition(app.id, 'approved'); r.transition(app.id, 'pending'); r.transition(app.id, 'applied')
    // 另一份投递：把 updated_at 拨回 30 天前制造静默（挂着笔试的那份有动静，不算静默）
    const quietJob = r.upsertJob({ source_platform: 'boss', source_job_id: 'j2', title: '后端开发', company_name: '戊公司' })
    const quiet = r.createApplication(quietJob.id)
    r.jumpTo(quiet.id, 'applied')
    r.db.update('application', app.id, { updated_at: '2026-09-01T00:00:00Z' })
    r.db.update('application', quiet.id, { updated_at: '2026-09-01T00:00:00Z' })
    r.createDeadline({ kind: 'assessment', title: '乙公司测评', due_at: '2026-10-02T10:00:00Z' })
    const written = r.createDeadline({ kind: 'written_test', title: '丙公司笔试', due_at: '2026-10-03T12:00:00Z', application_id: app.id })
    r.createDeadline({ kind: 'offer_reply', title: '丁公司 offer 回复', due_at: '2026-10-20T00:00:00Z' })
    r.enqueueAction('submit', { job_id: job.id }, app.id)
    r.createInboxItem({ raw_text: '新邮件' })

    const today = r.today(NOW)
    expect(today.items.map(i => i.kind)).toEqual(['deadline', 'review', 'inbox', 'stale', 'deadline'])
    // 过了时间的测评不当「已过期」催，而是问一句做了没有
    expect(today.items[4]).toMatchObject({ title: '乙公司测评：做了吗？', ask: 'attendance' })
    expect(today.items[0].detail).toContain('今天')
    // 挂在投递上的截止：ref 指向投递，deadline_id 仍给出截止事件本身，便于改期 / 完成
    expect(today.items[0].ref).toEqual({ type: 'application', id: app.id })
    expect(today.items[0].deadline_id).toBe(written.id)
    // 没回音的那份由 AI 收起，今日只留一条数字
    expect(r.getApplication(quiet.id)!.stage).toBe('discarded')
    expect(today.items[3]).toMatchObject({ ref: { type: 'silent_collected' }, title: '这周有 1 家一直没回音，已替你收起' })
    expect(today.waiting).toEqual({ count: 1, by_stage: [{ stage: 'applied', n: 1 }] })
    expect(today.pending_review).toBe(1)
    expect(today.inbox_new).toBe(1)
    expect(r.listDeadlines({ status: 'missed' }).map(d => d.title)).toEqual(['乙公司测评'])
    // 20 天后的事件不进今日
    expect(today.items.some(i => i.title.includes('丁公司'))).toBe(false)
  })
})

describe('过了时间的笔试 / 面试：问一句「考了吗」', () => {
  it('过了时间没打勾的笔试在队尾问「考了吗」；别的已过期事项照旧；答完从队列消失、卷宗记一笔', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'campus', source_job_id: 'mt', title: '后端', company_name: '美团' })
    const app = r.createApplication(job.id)
    const exam = r.createDeadline({ kind: 'written_test', title: '美团笔试', due_at: '2026-10-02T11:00:00.000Z', application_id: app.id })
    r.createDeadline({ kind: 'application_deadline', title: '乙公司网申截止', due_at: '2026-10-02T12:00:00.000Z' })

    const asked = r.today(NOW).items.find(i => i.deadline_id === exam.id)!
    expect(asked).toMatchObject({ title: '美团笔试：考了吗？', ask: 'attendance' })
    expect(r.today(NOW).items.find(i => i.title === '乙公司网申截止')?.ask).toBeUndefined()

    expect(r.answerAttendance(exam.id, false).status).toBe('skipped')
    expect(r.today(NOW).items.map(i => i.deadline_id)).not.toContain(exam.id)
    expect(r.listDossierNotes(app.id).map(n => n.content)).toEqual(['美团笔试：没参加（回来时确认）'])
  })
})

describe('通知中心：处理完的信折起来', () => {
  it('inboxSettled：已归档且关联投递上没有开着的时间点才算处理完；没归档的永远不算', () => {
    const r = mem()
    const job = r.upsertJob({ source_platform: 'campus', source_job_id: 'jf', title: '后端', company_name: '九方云' })
    const app = r.createApplication(job.id)
    const mail = r.resolveInboxItem(r.createInboxItem({ raw_text: '在线测评' }).id, { kind: 'assessment', linked_type: 'application', linked_id: app.id })
    const test = r.createDeadline({ kind: 'assessment', title: '九方云测评', due_at: '2026-10-04T15:59:00.000Z', application_id: app.id })
    expect(r.inboxSettled(mail)).toBe(false)
    r.setDeadlineStatus(test.id, 'done')
    expect(r.inboxSettled(mail)).toBe(true)
    expect(r.inboxSettled(r.createInboxItem({ raw_text: '认不出来' }))).toBe(false)
  })
})

describe('面试改期', () => {
  it('rescheduleInterview：面试记录和它的时间点一起改；已过期改到将来变回未完成，做完的不动', () => {
    const r = mem()
    r.db.insert('interview', { id: 'itv1', round: 'first', date: '2026-10-01T06:00:00.000Z', tags_json: '[]', result: 'none', result_source: 'none', created_at: NOW, updated_at: NOW })
    const missed = r.createDeadline({ kind: 'interview', title: '一面', due_at: '2026-10-01T06:00:00.000Z', interview_id: 'itv1' })
    r.setDeadlineStatus(missed.id, 'missed')
    const done = r.createDeadline({ kind: 'interview', title: '一面（旧）', due_at: '2026-09-20T06:00:00.000Z', interview_id: 'itv1' })
    r.setDeadlineStatus(done.id, 'done')

    r.rescheduleInterview('itv1', '2026-10-05T02:00:00.000Z', NOW)

    expect(r.db.get<{ date: string }>('SELECT date FROM interview WHERE id=?', ['itv1'])?.date).toBe('2026-10-05T02:00:00.000Z')
    expect(r.getDeadline(missed.id)).toMatchObject({ due_at: '2026-10-05T02:00:00.000Z', status: 'open' })
    expect(r.getDeadline(done.id)).toMatchObject({ due_at: '2026-09-20T06:00:00.000Z', status: 'done' })
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

describe('静默看投递上最后一次动静', () => {
  it('阶段没变但来过笔试通知 / 还有没到的面试：不算静默；什么都没有才算', () => {
    const r = mem()
    const mk = (id: string) => { const j = r.upsertJob({ source_platform: 'boss', source_job_id: id, title: '后端开发', company_name: id }); const a = r.createApplication(j.id); r.jumpTo(a.id, 'applied'); r.db.update('application', a.id, { updated_at: '2026-09-01T00:00:00Z' }); return a.id }
    const exam = mk('笔试'); const later = mk('面试'); const quiet = mk('静默')
    r.createDeadline({ kind: 'written_test', title: '笔试', due_at: '2026-10-05T06:00:00Z', application_id: exam })
    const far = r.createDeadline({ kind: 'interview', title: '面试', due_at: '2026-10-30T06:00:00Z', application_id: later })
    r.db.run('UPDATE deadline SET created_at=? WHERE id=?', ['2026-09-02T00:00:00Z', far.id])
    r.today(NOW)
    expect([exam, later, quiet].map(id => r.getApplication(id)!.stage)).toEqual(['applied', 'applied', 'discarded'])
    // 收起的仍算静默，比例照实
    expect(r.funnel(NOW).overall!.silent).toBe(1)
  })
})

describe('关掉的投递重新打开', () => {
  it('只找投出过又被关掉的；重新打开回到已投递、写历史，不算一次新的投出；没关的不能重开', () => {
    const r = mem()
    const sent = r.createApplication(r.upsertJob({ source_platform: 'boss', source_job_id: 'b1', title: '后端开发', company_name: '字节跳动' }).id)
    r.jumpTo(sent.id, 'applied', '已投递'); r.jumpTo(sent.id, 'discarded', '静默超时，主动关闭')
    const never = r.createApplication(r.upsertJob({ source_platform: 'boss', source_job_id: 'b2', title: '算法', company_name: '字节跳动' }).id)
    r.jumpTo(never.id, 'discarded', '不投了')
    expect(r.findClosedSentApplicationsByCompany('字节跳动').map(a => a.id)).toEqual([sent.id])
    expect(r.reopenClosed(sent.id, '收到面试邀请').stage).toBe('applied')
    const last = r.stageHistory().filter(h => h.application_id === sent.id).at(-1)!
    expect(last.from_stage).toBe('discarded')
    expect(isSendNote(last.note)).toBe(false)
    expect(() => r.reopenClosed(sent.id, 'again')).toThrow()
  })
})

describe('没回音的线由 AI 收起', () => {
  it('等回音的阶段到阈值就收起，只报一个数；投递中卡住的仍逐条提醒；来信能接回', () => {
    const r = mem()
    const mk = (id: string, stage: 'applied' | 'interview' | 'pending', at: string) => {
      const a = r.createApplication(r.upsertJob({ source_platform: 'boss', source_job_id: id, title: '后端开发', company_name: id }).id)
      r.jumpTo(a.id, stage); r.db.update('application', a.id, { updated_at: at }); return a.id
    }
    const sent = mk('投出', 'applied', '2026-08-30T00:00:00Z'); const iv = mk('面试', 'interview', '2026-09-10T00:00:00Z')
    const young = mk('刚投', 'applied', '2026-09-20T00:00:00Z'); const stuck = mk('卡住', 'pending', '2026-09-20T00:00:00Z')
    const items = r.today(NOW).items.filter(i => i.kind === 'stale')
    expect(items.map(i => i.ref.type).sort()).toEqual(['application', 'silent_collected'])
    expect(items.find(i => i.ref.type === 'application')!.ref.id).toBe(stuck)
    expect(items.find(i => i.ref.type === 'silent_collected')!.title).toContain('2 家')
    expect(items.map(i => `${i.title}${i.detail}`).join()).not.toMatch(/挂了|别再想/)
    expect([sent, iv, young].map(id => r.getApplication(id)!.stage)).toEqual(['discarded', 'discarded', 'applied'])
    expect(r.findClosedSentApplicationsByCompany('投出').map(a => a.id)).toEqual([sent])
    // 再开一次今日：不重复收起
    expect(r.collectSilent(NOW)).toBe(0)
  })
})
