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
/** 两个 ISO 时刻取晚的；b 缺省时返回 a。静默判定的「最后一次动静」用它合并阶段变化和投递上的其他事件。 */
export function latestIso(a: string, b?: string | null): string {
  return b && Date.parse(b) > Date.parse(a) ? b : a
}
export interface SilenceVerdict { silent: boolean; days: number; threshold: number | null }
/** 停留天数超过阶段阈值即"可视为静默"；没有阈值的阶段永不静默。 */
export function silenceOf(stage: ApplicationStage, updatedAt: string, nowIso: string): SilenceVerdict {
  const threshold = SILENCE_DAYS[stage] ?? null
  const days = daysBetween(updatedAt, nowIso)
  return { silent: threshold !== null && days >= threshold, days, threshold }
}

// ---------- 今日队列 ----------
export type TodayItemKind = 'deadline' | 'review' | 'handoff' | 'stale' | 'inbox' | 'interview_today' | 'interview_retro' | 'followup' | 'mail_auth'
export interface TodayItem {
  kind: TodayItemKind
  /** 越小越靠前：0 邮箱连接失效（没有期限也排最前，挡住之后所有邮件）/ 1 今天到期 / 2 待审 / 3 接管 / 4 面试 / 5 收件箱 / 6 静默 / 7 近三天到期、时间未知 / 8 已过期 */
  priority: number
  title: string
  detail?: string
  due_at?: string | null
  ref: { type: string; id: string }
  /** 截止类条目的截止事件 id（ref 可能指向所属投递），供 deadline_update / deadline_done 直接使用。 */
  deadline_id?: string
  /** 面板一键动作对应的对话意图（带对象 id），为空则该项只能在面板处理。 */
  suggest?: string
  /** attendance：过了时间的笔试 / 测评 / 面试，问一句「考了吗」，答完收进卷宗（见 asksAttendance）。 */
  ask?: 'attendance'
}

export function sortToday(items: TodayItem[]): TodayItem[] {
  return [...items].sort((a, b) => a.priority - b.priority || (a.due_at ?? '').localeCompare(b.due_at ?? ''))
}

/**
 * 已过期的排在队尾：它已经没有外部期限可赶，回来时先给的应该是还赶得上的那件（世界模型 §2「紧急度由外部期限定」、
 * 方法准则 7「回来先给最急的一件」）。仍然留在队列里、不丢；用户可能已经在平台上考完，只是没回来打勾。
 */
export const OVERDUE_PRIORITY = 8

/**
 * 笔试、测评多在外部平台进行，他去没去我们看不见；没打勾不等于错过。
 * 过了时间、还没答过的，回来时问一句，不当成「已过期」去催。面试不在这里：过了时间提示复盘（pastInterviewToToday）。
 */
export const ATTENDANCE_KINDS: ReadonlySet<string> = new Set(['written_test', 'assessment'])
export const ATTENDANCE_QUESTION: Record<string, string> = { written_test: '考了吗？', assessment: '做了吗？' }

export function asksAttendance(d: Pick<Deadline, 'kind' | 'status' | 'due_at'>, nowIso: string): boolean {
  return ATTENDANCE_KINDS.has(d.kind) && (d.status === 'open' || d.status === 'missed') && !!d.due_at && Date.parse(d.due_at) < Date.parse(nowIso)
}

/** 只处理有时间的事件；时间未知（due_at 为 null）的由调用方（Repos.today）单独处理。 */
/** 面试时间过后多久内提示「面完了？说几句就能复盘」；过了就只留在卷宗里，不再催。 */
export const RETRO_PROMPT_HOURS = 24

/**
 * 面试时间过了 ≠ 错过：多半是已经面完、还没复盘。复盘会把时间点记为完成，所以这里还 open 的就是没复盘的。
 * 一天内给一条不标红的复盘提示，之后不再出现在今日队列。
 */
function pastInterviewToToday(d: Deadline & { due_at: string }, nowIso: string): TodayItem | null {
  const hours = (Date.parse(nowIso) - Date.parse(d.due_at)) / 3_600_000
  if (hours > RETRO_PROMPT_HOURS) return null
  const name = d.title.replace(/\s*面试/, '')
  return {
    kind: 'interview_retro', priority: 4, title: `${name} 面完了？`, detail: '说几句或传一段录音就能复盘', due_at: d.due_at,
    ref: { type: d.application_id ? 'application' : 'deadline', id: d.application_id ?? d.id }, deadline_id: d.id,
    suggest: `复盘一下 ${d.title}${d.application_id ? `（application_id=${d.application_id}）` : ''}`,
  }
}

export function deadlineToToday(d: Deadline & { due_at: string }, nowIso: string): TodayItem | null {
  if (d.status !== 'open') return null
  if (d.kind === 'interview' && Date.parse(d.due_at) < Date.parse(nowIso)) return pastInterviewToToday(d, nowIso)
  const days = daysBetween(nowIso, d.due_at)
  if (days > 3) return null
  const overdue = Date.parse(d.due_at) < Date.parse(nowIso)
  if (overdue && asksAttendance(d, nowIso)) {
    return {
      kind: 'deadline', priority: OVERDUE_PRIORITY, title: `${d.title}：${ATTENDANCE_QUESTION[d.kind]}`, detail: '答一下就收进卷宗', due_at: d.due_at,
      ref: { type: d.application_id ? 'application' : 'deadline', id: d.application_id ?? d.id }, deadline_id: d.id, ask: 'attendance',
    }
  }
  const label = overdue ? '已过期' : days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`
  return {
    kind: d.kind === 'interview' && days === 0 ? 'interview_today' : 'deadline',
    priority: overdue ? OVERDUE_PRIORITY : days === 0 ? (d.kind === 'interview' ? 4 : 1) : 7,
    // 面试是要去参加的一个时间，不是截止
    title: d.title, detail: d.kind === 'interview' ? label : `${label}截止`, due_at: d.due_at,
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
    detail: `${stageLabel(app.stage)}后 ${v.days} 天没有动静；可以先收起来，来信会自动接回`,
    ref: { type: 'application', id: app.id },
    suggest: `把 ${name} 这条投递先收起来（application_id=${app.id}）`,
  }
}

// ---------- 没回音的线由 AI 收起（2026-10-30 定，低谷面） ----------
/** 等招聘方回音的阶段：到静默阈值由 AI 自己收起，不逐条要用户点。投递中（pending）卡住是我们这边的事，仍逐条提醒。 */
export const COLLECTABLE_STAGES: readonly ApplicationStage[] = ['applied', 'responded', 'interview']
/** AI 收起一条没回音的线时，进入 discarded 那一步的备注；漏斗按它把收起的线仍算作「静默」。 */
export const SILENT_COLLECT_NOTE = '没回音，已收起'

/** 今日队列里只放一条数字：这周收起了几家。没有就不出。 */
export function collectedToToday(count: number, weekStart: string): TodayItem | null {
  if (count <= 0) return null
  return {
    kind: 'stale', priority: 6, title: `这周有 ${count} 家一直没回音，已替你收起`,
    detail: `投出 ${SILENCE_DAYS.applied} 天、面试后 ${SILENCE_DAYS.interview} 天没有任何动静就先收起；来信会自动接回`,
    ref: { type: 'silent_collected', id: weekStart },
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

/** 投出之后的漏斗层（Offer 层含已入职）。 */
export const FUNNEL_LAYERS = ['applied', 'responded', 'interview', 'offer'] as const
export type FunnelLayer = typeof FUNNEL_LAYERS[number]
const LAYER_OF: Partial<Record<ApplicationStage, number>> = { applied: 0, responded: 1, interview: 2, offer: 3, hired: 3 }

/**
 * 投递最远走到第几层（-1 = 还没投出）。按「走到过」算而不是按当前阶段：面试后被拒的投递当前是 rejected，
 * 但它确实过了回应和面试两层。reached 是阶段历史里出现过的阶段；没有历史时，被拒只可能发生在投出之后，
 * 算作投出；放弃可能发生在评估阶段，不算。
 */
export function furthestLayer(stage: ApplicationStage, reached: readonly string[] = []): number {
  let best = LAYER_OF[stage] ?? -1
  for (const s of reached) best = Math.max(best, LAYER_OF[s as ApplicationStage] ?? -1)
  if (best < 0 && stage === 'rejected') best = 0
  return best
}

export type FunnelInputRow = Application & { job: Pick<Job, 'title' | 'company_name' | 'source_platform'>; reached_stages?: readonly string[]; /** AI 因静默收起的（stage 已是 discarded，仍算静默） */ collected?: boolean }

export function funnelBy(
  rows: FunnelInputRow[],
  keyOf: (r: FunnelInputRow) => string,
  nowIso: string,
): FunnelRow[] {
  const map = new Map<string, FunnelRow>()
  for (const r of rows) {
    const key = keyOf(r)
    const f = map.get(key) ?? { key, total: 0, applied: 0, responded: 0, interview: 0, offer: 0, rejected: 0, silent: 0 }
    const layer = furthestLayer(r.stage, r.reached_stages)
    f.total++
    if (layer >= 0) f.applied++
    if (layer >= 1) f.responded++
    if (layer >= 2) f.interview++
    if (layer >= 3) f.offer++
    if (r.stage === 'rejected') f.rejected++
    if (r.collected || silenceOf(r.stage, r.updated_at, nowIso).silent) f.silent++
    map.set(key, f)
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

export function rate(n: number, d: number): number | null { return d > 0 ? Math.round((n / d) * 100) / 100 : null }
