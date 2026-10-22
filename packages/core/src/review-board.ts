/**
 * 漏斗与周复盘页的看板（纯函数，不碰数据库）。
 * 漏斗只看投出之后的累计结果（对方的决定），甘特只看本周有截止时间的事（自己的承诺），两张图不重叠。
 * 周的边界按本地时区算：tzOffsetMinutes 是本地相对 UTC 的分钟数（东八区为 480）。
 */
import type { ApplicationStage, DeadlineKind } from './states.js'
import type { Application, Deadline, Interview, Job } from './types.js'
import { FUNNEL_LAYERS, furthestLayer, silenceOf, weekStartOf, type FunnelLayer } from './surfaces.js'

export interface StageHistoryRow { application_id: string; from_stage: string | null; to_stage: string; created_at: string }

type AppRow = Application & { job: Pick<Job, 'title' | 'company_name' | 'source_platform'> }

export interface ReviewFunnelLayer {
  layer: FunnelLayer
  /** 走到过这一层的投递数。 */
  n: number
  /** 相对上一层的转化率；第一层为 null。 */
  rate: number | null
  /** 所选这周第一次走到这一层的投递数。 */
  new_this_week: number
  /** 最远就停在这一层的投递按去向拆开：还在等（未超沉默阈值）/ 沉默 / 被拒 / 主动放弃 / 已入职（只在 Offer 层）。 */
  stopped: { waiting: number; silent: number; rejected: number; discarded: number; hired: number }
  /** 走到下一层的投递在这一层停留天数的中位数；自动推进补出的零间隔不算。 */
  median_days_to_next: number | null
  /** 走到过这一层的投递（点开后在投递记录里筛这些）。 */
  application_ids: string[]
  /** 停在这一层、已超过沉默阈值的投递。 */
  silent_ids: string[]
  summary: string
}

export type GanttStatus = 'done' | 'open' | 'missed' | 'cancelled'
export interface GanttItem {
  id: string
  source: 'deadline' | 'interview'
  kind: DeadlineKind
  title: string
  company_name: string | null
  application_id: string | null
  /** 事情出现的时刻（条形起点）。 */
  start: string
  /** 截止 / 面试时刻（条形终点）。 */
  end: string
  status: GanttStatus
}

export interface DailyApplied { date: string; n: number; by_platform: Array<{ key: string; n: number }>; application_ids: string[] }

export interface ReviewBoard {
  week: { start: string; days: string[]; is_current: boolean; tz_offset_minutes: number }
  kpis: {
    applied: number; applied_prev: number; responded: number; interviews: number
    /** 本周到期（或已提前完成）的事项数，及其中完成 / 错过的数量。 */
    due: number; done: number; missed: number
    /** 累计：有回应 / 已投递。 */
    response_rate: number | null
  }
  funnel: ReviewFunnelLayer[]
  gantt: GanttItem[]
  /** 时间还没定的事项（不上甘特，只列出来）。 */
  undated: Array<Pick<GanttItem, 'id' | 'kind' | 'title' | 'company_name' | 'application_id'>>
  daily: DailyApplied[]
}

export const FUNNEL_LAYER_LABELS: Record<FunnelLayer, string> = { applied: '已投递', responded: '有回应', interview: '面试', offer: 'Offer' }

const DAY_MS = 86_400_000
const LAYER_OF: Partial<Record<string, number>> = { applied: 0, responded: 1, interview: 2, offer: 3, hired: 3 }

function localDate(ms: number, offsetMin: number): string { return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10) }
function addDays(date: string, n: number): string { return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10) }
function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function pct(r: number): string { return `${Math.round(r * 100)}%` }

export function buildReviewBoard(input: {
  apps: AppRow[]; history: StageHistoryRow[]; deadlines: Deadline[]; interviews: Interview[]
  nowIso: string; weekStart?: string; tzOffsetMinutes: number
}): ReviewBoard {
  const { apps, history, deadlines, interviews, nowIso, tzOffsetMinutes: off } = input
  const nowMs = Date.parse(nowIso)
  const currentWeek = weekStartOf(localDate(nowMs, off))
  // 非法的周参数（手写 URL 等）退回本周，不让整页报错
  const weekStart = input.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStart) && !Number.isNaN(Date.parse(input.weekStart)) ? weekStartOf(input.weekStart) : currentWeek
  const wsMs = Date.parse(weekStart + 'T00:00:00Z') - off * 60_000
  const weMs = wsMs + 7 * DAY_MS
  const inWeek = (ms: number) => ms >= wsMs && ms < weMs
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  // 每条投递第一次走到第 k 层（及以上）的时刻；历史缺失的老数据只按当前阶段计入人数，不计时间。
  const reached = new Map<string, string[]>()
  const enteredAt = new Map<string, number[]>()
  for (const h of history) {
    reached.set(h.application_id, [...(reached.get(h.application_id) ?? []), h.to_stage])
    const layer = LAYER_OF[h.to_stage]
    if (layer === undefined) continue
    const times = enteredAt.get(h.application_id) ?? []
    const t = Date.parse(h.created_at)
    for (let k = 0; k <= layer; k++) if (times[k] === undefined) times[k] = t
    enteredAt.set(h.application_id, times)
  }

  // ---------- 漏斗 ----------
  const furthest = new Map(apps.map(a => [a.id, furthestLayer(a.stage, reached.get(a.id))]))
  const funnel: ReviewFunnelLayer[] = FUNNEL_LAYERS.map((layer, k) => {
    const at = apps.filter(a => (furthest.get(a.id) ?? -1) >= k)
    const stoppedApps = at.filter(a => furthest.get(a.id) === k)
    const stopped = { waiting: 0, silent: 0, rejected: 0, discarded: 0, hired: 0 }
    const silentIds: string[] = []
    for (const a of stoppedApps) {
      if (a.stage === 'rejected') stopped.rejected++
      else if (a.stage === 'discarded') stopped.discarded++
      else if (a.stage === 'hired') stopped.hired++
      else if (silenceOf(a.stage as ApplicationStage, a.updated_at, nowIso).silent) { stopped.silent++; silentIds.push(a.id) }
      else stopped.waiting++
    }
    const waits: number[] = []
    for (const a of at) {
      const t = enteredAt.get(a.id)
      if (t?.[k] === undefined || t[k + 1] === undefined || t[k + 1] === t[k]) continue
      waits.push(Math.max(0, Math.round((t[k + 1] - t[k]) / DAY_MS)))
    }
    return {
      layer, n: at.length, rate: null,
      new_this_week: at.filter(a => { const t = enteredAt.get(a.id)?.[k]; return t !== undefined && inWeek(t) }).length,
      stopped, median_days_to_next: k < FUNNEL_LAYERS.length - 1 ? median(waits) : null,
      application_ids: at.map(a => a.id), silent_ids: silentIds, summary: '',
    }
  })
  funnel.forEach((l, k) => {
    if (k > 0) l.rate = funnel[k - 1].n > 0 ? l.n / funnel[k - 1].n : null
    l.summary = layerSummary(l, k > 0 ? funnel[k - 1] : null)
  })

  // ---------- 甘特：本周有截止时间的事 ----------
  const appById = new Map(apps.map(a => [a.id, a]))
  const companyOf = (applicationId: string | null) => (applicationId ? appById.get(applicationId)?.job.company_name ?? null : null)
  const overlaps = (startMs: number, endMs: number) => startMs < weMs && endMs >= wsMs
  const gantt: GanttItem[] = []
  const undated: ReviewBoard['undated'] = []
  for (const d of deadlines) {
    if (!d.due_at) {
      if (d.status === 'open') undated.push({ id: d.id, kind: d.kind, title: d.title, company_name: companyOf(d.application_id), application_id: d.application_id })
      continue
    }
    const endMs = Date.parse(d.due_at)
    const startMs = Math.min(Date.parse(d.created_at), endMs)
    if (!overlaps(startMs, endMs)) continue
    const status: GanttStatus = d.status === 'open' && endMs < nowMs ? 'missed' : d.status
    gantt.push({ id: d.id, source: 'deadline', kind: d.kind, title: d.title, company_name: companyOf(d.application_id), application_id: d.application_id, start: new Date(startMs).toISOString(), end: d.due_at, status })
  }
  // 面试表里有日期、但没有对应截止事项的面试也上甘特（同一投递同一天已有面试类截止就不重复）
  const interviewDays = new Set(deadlines.filter(d => d.kind === 'interview' && d.due_at).map(d => `${d.application_id}|${localDate(Date.parse(d.due_at!), off)}`))
  const linkedInterviews = new Set(deadlines.map(d => d.interview_id).filter(Boolean))
  for (const i of interviews) {
    if (!i.date || linkedInterviews.has(i.id)) continue
    const endMs = Date.parse(i.date)
    if (Number.isNaN(endMs) || interviewDays.has(`${i.application_id}|${localDate(endMs, off)}`)) continue
    const startMs = Math.min(Date.parse(i.created_at), endMs)
    if (!overlaps(startMs, endMs)) continue
    gantt.push({
      id: i.id, source: 'interview', kind: 'interview', title: `${i.company_name ?? companyOf(i.application_id) ?? ''} ${roundLabel(i.round)}`.trim(),
      company_name: i.company_name ?? companyOf(i.application_id), application_id: i.application_id,
      start: new Date(startMs).toISOString(), end: i.date, status: endMs < nowMs ? 'done' : 'open',
    })
  }
  gantt.sort((a, b) => a.end.localeCompare(b.end))

  // ---------- 每日投出 ----------
  const daily: DailyApplied[] = days.map(date => ({ date, n: 0, by_platform: [], application_ids: [] }))
  let appliedPrev = 0
  let responded = 0
  for (const a of apps) {
    const t = enteredAt.get(a.id)
    if (t?.[0] === undefined) continue
    if (t[0] >= wsMs - 7 * DAY_MS && t[0] < wsMs) appliedPrev++
    if (t[1] !== undefined && inWeek(t[1])) responded++
    if (!inWeek(t[0])) continue
    const day = daily[Math.floor((t[0] - wsMs) / DAY_MS)]
    day.n++; day.application_ids.push(a.id)
    const key = a.job.source_platform || '其他'
    const slot = day.by_platform.find(p => p.key === key)
    if (slot) slot.n++; else day.by_platform.push({ key, n: 1 })
  }
  daily.forEach(d => d.by_platform.sort((x, y) => y.n - x.n))

  // ---------- 顶部数字 ----------
  const dueItems = gantt.filter(g => g.status !== 'cancelled' && inWeek(Date.parse(g.end)) && (Date.parse(g.end) <= nowMs || g.status === 'done'))
  return {
    week: { start: weekStart, days, is_current: weekStart === currentWeek, tz_offset_minutes: off },
    kpis: {
      applied: daily.reduce((s, d) => s + d.n, 0), applied_prev: appliedPrev, responded,
      interviews: gantt.filter(g => g.kind === 'interview' && g.status !== 'cancelled' && inWeek(Date.parse(g.end))).length,
      due: dueItems.length, done: dueItems.filter(g => g.status === 'done').length, missed: dueItems.filter(g => g.status === 'missed').length,
      response_rate: funnel[0].n > 0 ? funnel[1].n / funnel[0].n : null,
    },
    funnel, gantt, undated, daily,
  }
}

function roundLabel(round: string): string {
  return ({ hr: 'HR 面', first: '一面', second: '二面', final: '终面', group: '群面' } as Record<string, string>)[round] ?? '面试'
}

/** 悬停时的一句话总结：给事实，不渲染焦虑（被拒、沉默是常态）。 */
function layerSummary(l: ReviewFunnelLayer, prev: ReviewFunnelLayer | null): string {
  const label = FUNNEL_LAYER_LABELS[l.layer]
  if (l.n === 0) return prev && prev.n > 0 ? `${FUNNEL_LAYER_LABELS[prev.layer]}的 ${prev.n} 条还没有走到${label}。` : `还没有投递走到${label}。`
  const head = prev ? `${FUNNEL_LAYER_LABELS[prev.layer]}的 ${prev.n} 条里，${l.n} 条走到了${label}（${pct(l.n / Math.max(1, prev.n))}）。` : `累计投出 ${l.n} 条。`
  const s = l.stopped
  const parts: string[] = []
  if (s.hired) parts.push(`${s.hired} 条已入职`)
  if (s.waiting) parts.push(`${s.waiting} 条${l.layer === 'offer' ? '待你决定' : '还在等'}`)
  if (s.silent) parts.push(`${s.silent} 条已超过沉默期，可以追问一次或放下`)
  if (s.rejected) parts.push(`${s.rejected} 条被拒`)
  if (s.discarded) parts.push(`${s.discarded} 条你主动放弃`)
  const tail = parts.length ? `停在这一步的：${parts.join('，')}。` : ''
  const wait = l.median_days_to_next !== null ? `走到下一步的，一般在这里等 ${l.median_days_to_next} 天。` : ''
  return `${head}${tail}${wait}`
}
