import { describe, it, expect } from 'vitest'
import { Db, Repos, buildMonthBoard, isSendNote, type Application, type Deadline, type Interview, type Offer, type StageHistoryRow } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

// 2026-10-28（周三）15:00 北京时间
const NOW = '2026-10-28T07:00:00.000Z'
const CN = 480

function app(id: string, stage: Application['stage'], company = `公司${id}`): Application & { job: { title: string; company_name: string; source_platform: string } } {
  return { id, job_id: `job_${id}`, resume_tailored_id: null, stage, next_action: null, next_action_due: null, blocker_reason: null, retry_strategy: null, submission_evidence: null, answers_used_json: '{}', page_url: null, created_at: '2026-09-01T00:00:00Z', updated_at: NOW, job: { title: '后端开发', company_name: company, source_platform: 'boss' } } as never
}
const h = (application_id: string, to_stage: string, created_at: string, note: string | null = '已提交（你批准后）'): StageHistoryRow => ({ application_id, from_stage: null, to_stage, note, created_at })
function exam(id: string, application_id: string, created_at: string, p: Partial<Deadline> = {}): Deadline {
  return { id, kind: 'written_test', title: id, due_at: '2026-10-20T11:00:00Z', application_id, job_id: null, interview_id: null, offer_id: null, source: 'mail', status: 'done', url: null, note: null, created_at, updated_at: NOW, ...p }
}

describe('isSendNote：只有真正的投递算投出', () => {
  it('产品提交、邮件投递、用户确认、用户自己说投了都算；邮件补建和手动记录不算', () => {
    for (const n of ['已提交（auto 模式）', '邮件投递已发送', '你确认已投递', '用户说已经在官网投了', null]) expect(isSendNote(n)).toBe(true)
    for (const n of ['自动推进（收到面试邀请（一面））', '收到测评', '收到笔试通知', '收到 Offer', '手动记录笔试']) expect(isSendNote(n)).toBe(false)
  })
})

describe('buildMonthBoard', () => {
  const apps = [
    app('a', 'offer', '阿里'), app('b', 'interview', '网易'), app('c', 'applied', '美团'), app('d', 'rejected', '京东'),
    app('e', 'applied', '小米'), app('f', 'interview', '快手'), app('s', 'applied', '字节'),
  ]
  const history = [
    // a：10/3 投出 → 笔试 → 面试 → Offer
    h('a', 'applied', '2026-10-03T02:00:00Z'), h('a', 'interview', '2026-10-12T02:00:00Z'), h('a', 'offer', '2026-10-22T02:00:00Z'),
    // b：10/8 投出，进了面试
    h('b', 'applied', '2026-10-08T02:00:00Z'), h('b', 'interview', '2026-10-15T02:00:00Z'),
    // c：10/25 投出（不满 7 天，还在路上）
    h('c', 'applied', '2026-10-25T02:00:00Z'),
    // d：10/5 投出，后来被拒
    h('d', 'applied', '2026-10-05T02:00:00Z'), h('d', 'rejected', '2026-10-15T02:00:00Z'),
    // e：9/10 投出（上个月）
    h('e', 'applied', '2026-09-10T02:00:00Z'),
    // f：邮件补建：10/20 收到面试邀请，路过 applied —— 不知道哪天投的
    h('f', 'applied', '2026-10-20T02:00:00Z', '自动推进（收到面试邀请）'), h('f', 'interview', '2026-10-20T02:00:00Z', '收到面试邀请'),
    // s：北京时间 10/1 0:30 投出（UTC 还是 9/30）
    h('s', 'applied', '2026-09-30T16:30:00Z'),
  ]
  const deadlines = [exam('x1', 'a', '2026-10-06T02:00:00Z'), exam('x2', 'd', '2026-10-09T02:00:00Z', { kind: 'assessment', status: 'missed' })]
  const interviews = [
    { id: 'i1', application_id: 'a', company_name: '阿里', round: 'first', date: '2026-10-14T06:00:00Z', created_at: '2026-10-12T02:00:00Z' },
    { id: 'i2', application_id: 'b', company_name: '网易', round: 'second', date: '2026-10-30T06:00:00Z', created_at: '2026-10-26T02:00:00Z' },
  ] as Interview[]
  const offers = [{ id: 'o1', application_id: 'a', company_name: '阿里', title: '后端开发', location: '杭州', deadline: '2026-11-05T09:00:00Z' }] as Offer[]
  const board = buildMonthBoard({ apps, history, deadlines, interviews, offers, agentSubmitted: 42, nowIso: NOW, tzOffsetMinutes: CN })

  it('本月四层：邮件补建的计入面试层，但不计入投出', () => {
    expect(board.month).toMatchObject({ key: '2026-10', days: 31, dow1: 4, today: 28, is_current: true, next_key: null })
    // 投出 a b c d s = 5；笔试 a d（有笔试）+ b、f（走到面试）= 4；面试 a b f = 3；Offer a = 1
    expect(board.counts).toEqual([5, 4, 3, 1])
  })
  it('上个月和年轮：第一个有数据的月份之前不比较', () => {
    expect(board.prev).toEqual([1, 0, 0, 0])
    expect(board.history.map((x) => x.key)).toEqual(['2026-09'])
    expect(board.month.prev_key).toBe('2026-09')
    const sep = buildMonthBoard({ apps, history, deadlines, interviews, offers, agentSubmitted: 42, nowIso: NOW, month: '2026-09', tzOffsetMinutes: CN })
    expect(sep.prev).toBeNull()
    expect(sep.history).toEqual([])
    expect(sep.month).toMatchObject({ is_current: false, today: null, next_key: '2026-10', prev_key: null })
  })
  it('每一天：按投出那天，拆成后来最远走到哪；最近 7 天标为还没结果', () => {
    expect(board.days[0]).toMatchObject({ day: 1, sent: 1, split: [1, 0, 0, 0] })
    expect(board.days[2]).toMatchObject({ day: 3, sent: 1, split: [0, 0, 0, 1], pending: false })
    expect(board.days[2].companies.offer).toEqual(['阿里'])
    expect(board.days[24]).toMatchObject({ day: 25, sent: 1, pending: true })
    expect(board.days.reduce((s, d) => s + d.sent, 0)).toBe(5)
    expect(board.in_transit).toBe(1)
  })
  it('面板：本月的笔试、面试轮次、Offer、下一场', () => {
    expect(board.exams.map((e) => e.company).sort()).toEqual(['京东', '阿里'])
    expect(board.interviews.find((r) => r.company === '阿里')!.rounds).toEqual([{ round: '一面', done: true, date: '2026-10-14T06:00:00Z' }])
    expect(board.next_interview).toEqual({ company: '网易', round: '二面', date: '2026-10-30T06:00:00Z' })
    expect(board.offers).toEqual([{ company: '阿里', title: '后端开发', location: '杭州', reply_by: '2026-11-05T09:00:00Z' }])
  })
  it('替你投出照传；他自己的节奏：样本不足 5 个时不给回音天数', () => {
    expect(board.since_total).toBe(42)
    expect(board.rhythm.reply_days).toBeNull()
    // 第一次进面试（10/12）之前投出过：e(9/10) s(9/30) a(10/3) d(10/5) b(10/8) = 5 份
    expect(board.rhythm.first_interview_after).toBe(5)
  })
  it('未来的月份退回本月；非法参数也退回本月', () => {
    expect(buildMonthBoard({ apps, history, deadlines, interviews, offers, agentSubmitted: 0, nowIso: NOW, month: '2026-12', tzOffsetMinutes: CN }).month.key).toBe('2026-10')
    expect(buildMonthBoard({ apps, history, deadlines, interviews, offers, agentSubmitted: 0, nowIso: NOW, month: 'oops', tzOffsetMinutes: CN }).month.key).toBe('2026-10')
  })
})

describe('Repos.monthBoard', () => {
  it('替你投出只数 done 的 submit / send_mail；历史带上备注', () => {
    const r = mem()
    const j1 = r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '后端', company_name: 'A' })
    const j2 = r.upsertJob({ source_platform: 'boss', source_job_id: '2', title: '后端', company_name: 'B' })
    const a1 = r.createApplication(j1.id); const a2 = r.createApplication(j2.id)
    r.jumpTo(a1.id, 'applied', '已提交（auto 模式）')
    r.jumpTo(a2.id, 'interview', '收到面试邀请')
    const done = r.enqueueAction('submit', {}, a1.id)
    r.db.update('action_queue', done.id, { status: 'done' })
    r.enqueueAction('submit', {}, a2.id)
    expect(r.agentSubmittedCount()).toBe(1)
    const b = r.monthBoard({ tzOffsetMinutes: 480 })
    expect(b.counts).toEqual([1, 1, 1, 0])
    expect(b.since_total).toBe(1)
  })
})
