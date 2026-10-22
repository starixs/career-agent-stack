import { describe, it, expect } from 'vitest'
import { Db, Repos, buildReviewBoard, furthestLayer, type Application, type Deadline, type Interview, type StageHistoryRow } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

// 2026-10-22（周四）15:00 北京时间
const NOW = '2026-10-22T07:00:00.000Z'
const CN = 480

function app(id: string, stage: Application['stage'], updated_at = NOW, platform = 'boss'): Application & { job: { title: string; company_name: string; source_platform: string } } {
  return { id, job_id: `job_${id}`, resume_tailored_id: null, stage, next_action: null, next_action_due: null, blocker_reason: null, retry_strategy: null, submission_evidence: null, answers_used_json: '{}', page_url: null, created_at: '2026-09-01T00:00:00Z', updated_at, job: { title: '后端开发', company_name: `公司${id}`, source_platform: platform } } as never
}
function hist(application_id: string, ...steps: Array<[string, string]>): StageHistoryRow[] {
  return steps.map(([to_stage, created_at]) => ({ application_id, from_stage: null, to_stage, created_at }))
}
function ddl(id: string, p: Partial<Deadline>): Deadline {
  return { id, kind: 'written_test', title: id, due_at: null, application_id: null, job_id: null, interview_id: null, offer_id: null, source: 'mail', status: 'open', url: null, note: null, created_at: '2026-10-19T02:00:00Z', updated_at: NOW, ...p }
}

describe('漏斗按最远到达阶段计数', () => {
  it('评估阶段就放弃的不算投出；面试后被拒的仍算进回应和面试层', () => {
    const r = mem()
    const j1 = r.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '后端开发', company_name: 'A' })
    const j2 = r.upsertJob({ source_platform: 'boss', source_job_id: '2', title: '后端开发', company_name: 'B' })
    const a1 = r.createApplication(j1.id); const a2 = r.createApplication(j2.id)
    r.transition(a1.id, 'discarded')
    r.jumpTo(a2.id, 'interview'); r.transition(a2.id, 'rejected')
    const f = r.funnel(NOW).overall!
    expect(f).toMatchObject({ total: 2, applied: 1, responded: 1, interview: 1, rejected: 1 })
  })
  it('没有历史时：被拒算投出，放弃不算', () => {
    expect(furthestLayer('rejected')).toBe(0)
    expect(furthestLayer('discarded')).toBe(-1)
    expect(furthestLayer('rejected', ['evaluated', 'applied', 'interview', 'rejected'])).toBe(2)
    expect(furthestLayer('hired')).toBe(3)
  })
})

describe('看板', () => {
  const apps = [
    app('a', 'rejected'), app('b', 'interview'), app('c', 'applied', '2026-09-01T00:00:00Z'), app('d', 'applied', '2026-10-20T03:00:00Z', 'campus'),
  ]
  const history = [
    ...hist('a', ['applied', '2026-10-01T00:00:00Z'], ['responded', '2026-10-05T00:00:00Z'], ['interview', '2026-10-09T00:00:00Z'], ['rejected', '2026-10-12T00:00:00Z']),
    // b：本周收到面试邀请，邮件归档自动补了 responded，时间相同
    ...hist('b', ['applied', '2026-10-13T00:00:00Z'], ['responded', '2026-10-20T01:00:00Z'], ['interview', '2026-10-20T01:00:00Z']),
    ...hist('c', ['applied', '2026-09-01T00:00:00Z']),
    // d：北京时间周一 0:30 投出（UTC 还是周日）
    ...hist('d', ['applied', '2026-10-18T16:30:00Z']),
  ]
  const deadlines = [
    ddl('done', { due_at: '2026-10-21T06:00:00Z', status: 'done' }),
    ddl('late', { due_at: '2026-10-20T06:00:00Z', status: 'open' }),
    ddl('next', { due_at: '2026-10-24T06:00:00Z', status: 'open', kind: 'interview', application_id: 'b' }),
    ddl('old', { due_at: '2026-10-10T06:00:00Z', status: 'done', created_at: '2026-10-01T00:00:00Z' }),
    ddl('tbd', { due_at: null, status: 'open', kind: 'assessment' }),
  ]
  const interviews = [
    { id: 'i1', application_id: 'b', company_name: '公司b', round: 'first', date: '2026-10-24T08:00:00Z', created_at: '2026-10-20T01:00:00Z' },
    { id: 'i2', application_id: 'a', company_name: '公司a', round: 'second', date: '2026-10-21T02:00:00Z', created_at: '2026-10-19T00:00:00Z' },
  ] as Interview[]
  const board = buildReviewBoard({ apps, history, deadlines, interviews, nowIso: NOW, tzOffsetMinutes: CN })

  it('周按本地时区从周一开始', () => {
    expect(board.week).toMatchObject({ start: '2026-10-19', is_current: true })
    expect(board.daily[0]).toMatchObject({ date: '2026-10-19', n: 1, application_ids: ['d'] })
  })
  it('漏斗：人数、转化、新增、停在这一层的去向', () => {
    expect(board.funnel.map(l => l.n)).toEqual([4, 2, 2, 0])
    expect(board.funnel[1].rate).toBe(0.5)
    expect(board.funnel[1].new_this_week).toBe(1)
    expect(board.funnel[0].stopped).toMatchObject({ waiting: 1, silent: 1 })
    expect(board.funnel[0].silent_ids).toEqual(['c'])
    expect(board.funnel[2].stopped).toMatchObject({ waiting: 1, rejected: 1 })
    expect(board.funnel[0].summary).toContain('累计投出 4 条')
  })
  it('停留天数中位数不算自动推进的零间隔', () => {
    expect(board.funnel[0].median_days_to_next).toBe(5.5) // a 4 天、b 7 天
    expect(board.funnel[1].median_days_to_next).toBe(4) // b 的 0 间隔被排除
  })
  it('甘特：只收和本周有交集的事；过期未完成算错过；有对应截止的面试不重复', () => {
    expect(board.gantt.map(g => g.id)).toEqual(['late', 'i2', 'done', 'next'])
    expect(board.gantt.find(g => g.id === 'late')!.status).toBe('missed')
    expect(board.gantt.find(g => g.id === 'i2')).toMatchObject({ source: 'interview', title: '公司a 二面', status: 'done' })
    expect(board.undated.map(u => u.id)).toEqual(['tbd'])
  })
  it('顶部数字', () => {
    expect(board.kpis).toMatchObject({ applied: 1, applied_prev: 1, responded: 1, interviews: 2, due: 3, done: 2, missed: 1, response_rate: 0.5 })
  })
  it('可以看上一周', () => {
    const prev = buildReviewBoard({ apps, history, deadlines, interviews, nowIso: NOW, weekStart: '2026-10-14', tzOffsetMinutes: CN })
    expect(prev.week).toMatchObject({ start: '2026-10-12', is_current: false })
    expect(prev.kpis.applied).toBe(1)
    expect(prev.gantt).toEqual([])
    expect(buildReviewBoard({ apps, history, deadlines, interviews, nowIso: NOW, weekStart: 'oops', tzOffsetMinutes: CN }).week.start).toBe('2026-10-19')
  })
})
