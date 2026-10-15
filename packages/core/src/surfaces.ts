/**
 * 五个面（收件箱 / 今日 / 卷宗 / 素材 / 复盘）共用的纯函数：岗位类别归类、周起点、静默判定、今日队列排序、漏斗统计。
 * 不碰数据库；Repos 取数后交给这里计算，渲染端与侧车也可直接复用（保证同一判断只有一份实现）。
 */
import { SILENCE_DAYS, type ApplicationStage } from './states.js'
import type { Application, Deadline, Job } from './types.js'

// ---------- 岗位类别（代理反馈的分组维度） ----------
export const JOB_CATEGORIES = ['开发', '算法与数据', '产品', '运营', '设计', '市场与销售', '财务与咨询', '职能', '其他'] as const
export type JobCategory = typeof JOB_CATEGORIES[number]

const CATEGORY_RULES: Array<[JobCategory, RegExp]> = [
  ['算法与数据', /算法|数据|机器学习|深度学习|nlp|cv\b|推荐|风控|量化|分析师|bi\b|data|analyst|ml\b|ai\b/i],
  ['开发', /开发|工程师|研发|前端|后端|全栈|测试|运维|客户端|ios|android|java|golang|c\+\+|python|sre|devops|software|engineer|developer/i],
  ['产品', /产品|product|pm\b/i],
  ['运营', /运营|operation|社群|内容|新媒体|主播|电商/i],
  ['设计', /设计|ui\b|ux\b|视觉|交互|美术|design/i],
  ['市场与销售', /市场|销售|商务|bd\b|marketing|sales|品牌|公关|投放|增长/i],
  ['财务与咨询', /财务|会计|审计|咨询|投行|金融|投资|风险|研究员|consult|finance|税务/i],
  ['职能', /人力|hr\b|行政|法务|采购|助理|秘书|培训|管培/i],
]

export function classifyJobTitle(title: string | null | undefined): JobCategory {
  const t = (title ?? '').trim()
  if (!t) return '其他'
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat
  return '其他'
}

// ---------- 时间 ----------
export function dateOnly(iso: string): string { return iso.slice(0, 10) }
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(dateOnly(fromIso)); const b = Date.parse(dateOnly(toIso))
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}
/** 周一为一周起点（YYYY-MM-DD）。 */
export function weekStartOf(iso: string): string {
  const d = new Date(dateOnly(iso) + 'T00:00:00Z')
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return d.toISOString().slice(0, 10)
}

// ---------- 静默判定 ----------
export interface SilenceVerdict { silent: boolean; days: number; threshold: number | null }
/** 停留天数超过阶段阈值即"可视为静默"；没有阈值的阶段永不静默。 */
export function silenceOf(stage: ApplicationStage, updatedAt: string, nowIso: string): SilenceVerdict {
  const threshold = SILENCE_DAYS[stage] ?? null
  const days = daysBetween(updatedAt, nowIso)
  return { silent: threshold !== null && days >= threshold, days, threshold }
}

// ---------- 今日队列 ----------
export type TodayItemKind = 'deadline' | 'review' | 'handoff' | 'stale' | 'inbox' | 'interview_today' | 'followup'
export interface TodayItem {
  kind: TodayItemKind
  /** 越小越靠前：0 已过期 / 1 今天到期 / 2 待审 / 3 接管 / 4 面试 / 5 收件箱 / 6 静默 / 7 跟进 */
  priority: number
  title: string
  detail?: string
  due_at?: string | null
  ref: { type: string; id: string }
  /** 截止类条目的截止事件 id（ref 可能指向所属投递），供 deadline_update / deadline_done 直接使用。 */
  deadline_id?: string
  /** 面板一键动作对应的对话意图（带对象 id），为空则该项只能在面板处理。 */
  suggest?: string
}

export function sortToday(items: TodayItem[]): TodayItem[] {
  return [...items].sort((a, b) => a.priority - b.priority || (a.due_at ?? '').localeCompare(b.due_at ?? ''))
}

/** 只处理有时间的事件；时间未知（due_at 为 null）的由调用方（Repos.today）单独处理。 */
export function deadlineToToday(d: Deadline & { due_at: string }, nowIso: string): TodayItem | null {
  if (d.status !== 'open') return null
  const days = daysBetween(nowIso, d.due_at)
  if (days > 3) return null
  const overdue = Date.parse(d.due_at) < Date.parse(nowIso)
  const label = overdue ? '已过期' : days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`
  return {
    kind: d.kind === 'interview' && days === 0 ? 'interview_today' : 'deadline',
    priority: overdue ? 0 : days === 0 ? (d.kind === 'interview' ? 4 : 1) : 7,
    title: d.title, detail: `${label}截止`, due_at: d.due_at,
    ref: { type: d.application_id ? 'application' : 'deadline', id: d.application_id ?? d.id },
    deadline_id: d.id,
  }
}

export function staleToToday(app: Application & { title?: string; company_name?: string | null }, nowIso: string): TodayItem | null {
  const v = silenceOf(app.stage, app.updated_at, nowIso)
  if (!v.silent) return null
  const name = `${app.company_name ?? '未知公司'} · ${app.title ?? ''}`.trim()
  return {
    kind: 'stale', priority: 6, title: `${name} 已静默 ${v.days} 天`,
    detail: `${stageLabel(app.stage)}后无任何动静，超过 ${v.threshold} 天可视为挂了，建议关闭这条线别再想它`,
    ref: { type: 'application', id: app.id },
    suggest: `把 ${name} 这条投递按静默超时关闭（application_id=${app.id}）`,
  }
}

export function stageLabel(stage: ApplicationStage): string {
  const map: Record<ApplicationStage, string> = {
    evaluated: '已评估', ready: '待批准', approved: '已批准', pending: '投递中', blocked: '卡住', needs_user: '需要你',
    applied: '已投递', responded: '有回应', interview: '面试中', offer: '已拿 Offer', rejected: '已拒', discarded: '已关闭', skip: '跳过', hired: '已入职',
  }
  return map[stage] ?? stage
}

// ---------- 漏斗 / 代理反馈 ----------
export interface FunnelRow { key: string; total: number; applied: number; responded: number; interview: number; offer: number; rejected: number; silent: number }
const AFTER_APPLY: ApplicationStage[] = ['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired']
const AFTER_RESPOND: ApplicationStage[] = ['responded', 'interview', 'offer', 'hired']
const AFTER_INTERVIEW: ApplicationStage[] = ['interview', 'offer', 'hired']

export function funnelBy(
  rows: Array<Application & { job: Pick<Job, 'title' | 'company_name' | 'source_platform'> }>,
  keyOf: (r: Application & { job: Pick<Job, 'title' | 'company_name' | 'source_platform'> }) => string,
  nowIso: string,
): FunnelRow[] {
  const map = new Map<string, FunnelRow>()
  for (const r of rows) {
    const key = keyOf(r)
    const f = map.get(key) ?? { key, total: 0, applied: 0, responded: 0, interview: 0, offer: 0, rejected: 0, silent: 0 }
    f.total++
    if (AFTER_APPLY.includes(r.stage)) f.applied++
    if (AFTER_RESPOND.includes(r.stage)) f.responded++
    if (AFTER_INTERVIEW.includes(r.stage)) f.interview++
    if (r.stage === 'offer' || r.stage === 'hired') f.offer++
    if (r.stage === 'rejected') f.rejected++
    if (silenceOf(r.stage, r.updated_at, nowIso).silent) f.silent++
    map.set(key, f)
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

export function rate(n: number, d: number): number | null { return d > 0 ? Math.round((n / d) * 100) / 100 : null }
