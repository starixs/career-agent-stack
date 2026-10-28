/**
 * 「我的求职月」看板（纯函数，不碰数据库）。这一页是复盘：只回看已经发生的事，推进任务归通知中心和日历页。
 *
 * 口径（2026-10-28 定）：
 * - 自然月，按投出日期分批；月份边界按本地时区（tzOffsetMinutes = 本地相对 UTC 的分钟数，东八区 480）。
 * - 四层：投出 → 笔试/测评 → 面试 → Offer，按「走到过」计（Offer 含已入职）。
 * - 「投出」只认真正的投递时刻：第一次进入 applied 且备注不是邮件补建 / 手动记录（见 isSendNote）。
 *   邮件补建、手动记录的投递不知道哪天投的：计入它们实际走到的层（归到第一次走到笔试及以后的那个月），不计入任何月份的投出。
 * - 投出不满 7 天、还停在投出的算「还在路上」。
 * - 「替你投出」= 产品亲手完成提交的投递（action_queue 里 done 的 submit / send_mail），从开始用起累计。
 */
import type { Application, Deadline, Interview, Job, Offer } from './types.js'

export interface StageHistoryRow { application_id: string; from_stage: string | null; to_stage: string; note?: string | null; created_at: string }

type AppRow = Application & { job: Pick<Job, 'title' | 'company_name' | 'source_platform'> }

export const MONTH_LAYERS = ['投出', '笔试/测评', '面试', 'Offer'] as const

/** 进入 applied 的这一步是不是真的投递。邮件补建（自动推进 / 收到测评 / 收到笔试通知）和手动记录都不是。 */
export function isSendNote(note: string | null | undefined): boolean {
  return !/^(自动推进（|收到测评|收到笔试通知|收到面试邀请|收到 Offer|手动记录)/.test(note ?? '')
}

export interface MonthCounts { counts: [number, number, number, number] }
export interface MonthDay {
  day: number
  /** 这天投出的份数，以及它们后来最远走到哪：[停在投出, 只到笔试, 只到面试, 拿到 Offer] */
  sent: number
  split: [number, number, number, number]
  /** 投出不满 7 天：结果还没来 */
  pending: boolean
  companies: { exam: string[]; interview: string[]; offer: string[] }
}
export interface MonthBoard {
  month: { key: string; year: number; month: number; days: number; dow1: number; today: number | null; is_current: boolean; prev_key: string | null; next_key: string | null }
  counts: [number, number, number, number]
  /** 上个月；第一个有数据的月份之前不比较 */
  prev: [number, number, number, number] | null
  /** 更早的月份（最近的在前，最多 3 个），画年轮 */
  history: Array<{ key: string; month: number; counts: [number, number, number, number] }>
  in_transit: number
  since_total: number
  days: MonthDay[]
  exams: Array<{ company: string; kind: 'assessment' | 'written_test'; status: string; due_at: string | null }>
  interviews: Array<{ company: string; rounds: Array<{ round: string; done: boolean; date: string | null }> }>
  next_interview: { company: string; round: string; date: string } | null
  offers: Array<{ company: string; title: string | null; location: string | null; reply_by: string | null }>
  rhythm: { reply_days: number | null; first_interview_after: number | null }
}

const DAY_MS = 86_400_000
const OPEN_STAGES = new Set(['applied', 'responded', 'interview', 'offer'])

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function buildMonthBoard(input: {
  apps: AppRow[]; history: StageHistoryRow[]; deadlines: Deadline[]; interviews: Interview[]; offers: Offer[]
  agentSubmitted: number; nowIso: string; month?: string; tzOffsetMinutes: number
}): MonthBoard {
  const { apps, history, deadlines, interviews, offers, nowIso, tzOffsetMinutes: off } = input
  const nowMs = Date.parse(nowIso)
  const local = (ms: number) => new Date(ms + off * 60_000)
  const keyOf = (ms: number) => { const d = local(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') }
  const curKey = keyOf(nowMs)
  const key = input.month && /^\d{4}-\d{2}$/.test(input.month) && input.month <= curKey ? input.month : curKey
  const shift = (k: string, by: number) => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + by, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') }

  // 每份投递：真正投出的时刻、第一次走到第 k 层的时刻、最远走到哪
  const exams = new Map<string, Deadline[]>()
  for (const d of deadlines) {
    if (d.status === 'cancelled' || (d.kind !== 'assessment' && d.kind !== 'written_test')) continue
    const app = d.application_id ? d.application_id : apps.find((a) => !d.application_id && d.job_id && a.job_id === d.job_id)?.id
    if (app) exams.set(app, [...(exams.get(app) ?? []), d])
  }
  const STAGE_LAYER: Record<string, number> = { interview: 2, offer: 3, hired: 3 }
  const info = new Map<string, { sendAt: number | null; reach: Array<number | null>; furthest: number }>()
  for (const a of apps) info.set(a.id, { sendAt: null, reach: [null, null, null, null], furthest: -1 })
  for (const h of history) {
    const it = info.get(h.application_id); if (!it) continue
    const t = Date.parse(h.created_at)
    if (h.to_stage === 'applied' && it.sendAt === null && isSendNote(h.note)) it.sendAt = t
    const k = STAGE_LAYER[h.to_stage]
    if (k !== undefined) { for (let j = 1; j <= k; j++) if (it.reach[j] === null) it.reach[j] = t; it.furthest = Math.max(it.furthest, k) }
  }
  for (const a of apps) {
    const it = info.get(a.id)!
    const k = STAGE_LAYER[a.stage]
    if (k !== undefined && it.furthest < k) { it.furthest = k; for (let j = 1; j <= k; j++) if (it.reach[j] === null) it.reach[j] = Date.parse(a.updated_at) }
    const ex = exams.get(a.id)
    if (ex?.length) {
      const t = Math.min(...ex.map((d) => Date.parse(d.created_at)))
      it.furthest = Math.max(it.furthest, 1)
      if (it.reach[1] === null || t < it.reach[1]) it.reach[1] = t
    }
    if (it.sendAt !== null) { it.reach[0] = it.sendAt; it.furthest = Math.max(it.furthest, 0) }
  }

  // 某个月的四层：本月投出的那批 + 没有投出日期、但在本月第一次走到笔试及以后的
  const countsOf = (k: string): [number, number, number, number] => {
    const c: [number, number, number, number] = [0, 0, 0, 0]
    for (const it of info.values()) {
      if (it.sendAt !== null) {
        if (keyOf(it.sendAt) !== k) continue
        for (let j = 0; j <= it.furthest; j++) c[j]++
      } else if (it.furthest >= 1 && it.reach[1] !== null && keyOf(it.reach[1]) === k) {
        for (let j = 1; j <= it.furthest; j++) c[j]++
      }
    }
    return c
  }
  const allMonths = [...info.values()].flatMap((it) => [it.sendAt, it.reach[1]]).filter((t): t is number => t !== null).map(keyOf)
  const firstKey = allMonths.length ? allMonths.reduce((a, b) => (a < b ? a : b)) : key
  const prevKey = shift(key, -1)
  const history_ = [1, 2, 3].map((i) => shift(key, -i)).filter((k) => k >= firstKey).map((k) => ({ key: k, month: Number(k.slice(5)), counts: countsOf(k) }))

  // 每一天
  const [Y, M] = key.split('-').map(Number)
  const days = new Date(Date.UTC(Y, M, 0)).getUTCDate()
  const dow1 = new Date(Date.UTC(Y, M - 1, 1)).getUTCDay()
  const isCurrent = key === curKey
  const today = isCurrent ? local(nowMs).getUTCDate() : null
  const appById = new Map(apps.map((a) => [a.id, a]))
  const name = (id: string) => appById.get(id)?.job.company_name ?? '未知公司'
  const dayList: MonthDay[] = Array.from({ length: days }, (_, i) => ({ day: i + 1, sent: 0, split: [0, 0, 0, 0], pending: false, companies: { exam: [], interview: [], offer: [] } }))
  let inTransit = 0
  for (const [id, it] of info) {
    if (it.sendAt === null || keyOf(it.sendAt) !== key) continue
    const d = dayList[local(it.sendAt).getUTCDate() - 1]
    const top = Math.max(0, it.furthest)
    d.sent++; d.split[top]++
    if (top === 1) d.companies.exam.push(name(id)); if (top === 2) d.companies.interview.push(name(id)); if (top === 3) d.companies.offer.push(name(id))
    const young = nowMs - it.sendAt < 7 * DAY_MS
    if (young) d.pending = true
    if (young && top === 0 && OPEN_STAGES.has(appById.get(id)?.stage ?? '')) inTransit++
  }

  // 面板：本月走到笔试及以后的那些投递的笔试 / 面试 / Offer
  const inMonth = (id: string, layer: number) => {
    const it = info.get(id); if (!it || it.furthest < layer) return false
    return it.sendAt !== null ? keyOf(it.sendAt) === key : it.reach[1] !== null && keyOf(it.reach[1]) === key
  }
  const examRows = [...exams.entries()].filter(([id]) => inMonth(id, 1)).flatMap(([id, ds]) => ds.map((d) => ({ company: name(id), kind: d.kind as 'assessment' | 'written_test', status: d.status, due_at: d.due_at })))
    .sort((a, b) => (b.due_at ?? '').localeCompare(a.due_at ?? ''))
  const ivByApp = new Map<string, Interview[]>()
  for (const iv of interviews) if (iv.application_id && inMonth(iv.application_id, 2)) ivByApp.set(iv.application_id, [...(ivByApp.get(iv.application_id) ?? []), iv])
  const ROUND: Record<string, string> = { hr: 'HR 面', first: '一面', second: '二面', final: '终面', group: '群面', other: '面试' }
  const interviewRows = [...ivByApp.entries()].map(([id, ivs]) => ({
    company: name(id),
    rounds: ivs.sort((a, b) => (a.date ?? a.created_at).localeCompare(b.date ?? b.created_at)).map((iv) => ({ round: ROUND[iv.round] ?? '面试', done: !!iv.date && Date.parse(iv.date) <= nowMs, date: iv.date })),
  }))
  const upcoming = interviews.filter((iv) => iv.date && Date.parse(iv.date) > nowMs).sort((a, b) => a.date!.localeCompare(b.date!))[0]
  const offerRows = offers.filter((o) => o.application_id && inMonth(o.application_id, 3)).map((o) => {
    const app = appById.get(o.application_id!)
    return { company: o.company_name ?? app?.job.company_name ?? '未知公司', title: o.title ?? app?.job.title ?? null, location: o.location, reply_by: o.deadline }
  })

  // 他自己的节奏：投出到第一次有进展的天数中位数；第一次进面试前投出过多少份（都不按月，看全部历史）
  const replyDays = [...info.values()].filter((it) => it.sendAt !== null && it.reach[1] !== null && it.reach[1]! >= it.sendAt!).map((it) => Math.round((it.reach[1]! - it.sendAt!) / DAY_MS))
  const firstIv = Math.min(...[...info.values()].map((it) => it.reach[2] ?? Infinity))
  const sendsBeforeIv = Number.isFinite(firstIv) ? [...info.values()].filter((it) => it.sendAt !== null && it.sendAt! < firstIv).length : null

  return {
    month: { key, year: Y, month: M, days, dow1, today, is_current: isCurrent, prev_key: prevKey >= firstKey ? prevKey : null, next_key: isCurrent ? null : shift(key, 1) },
    counts: countsOf(key),
    prev: prevKey >= firstKey ? countsOf(prevKey) : null,
    history: history_,
    in_transit: inTransit,
    since_total: input.agentSubmitted,
    days: dayList,
    exams: examRows,
    interviews: interviewRows,
    next_interview: upcoming ? { company: upcoming.company_name ?? (upcoming.application_id ? name(upcoming.application_id) : '未知公司'), round: ROUND[upcoming.round] ?? '面试', date: upcoming.date! } : null,
    offers: offerRows,
    rhythm: {
      reply_days: replyDays.length >= 5 ? median(replyDays) : null,
      first_interview_after: sendsBeforeIv && sendsBeforeIv > 0 ? sendsBeforeIv : null,
    },
  }
}
