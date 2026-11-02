/**
 * 要你的事（规范 CAREER_INTELLIGENT_UI.md §5.2、§5.3、§8 AskView）：等你条和卡组只按它渲染。
 *
 * 由截止（deadline）、待批准动作（action_queue）、接管（handoff）派生，来源邮件（inbox_item）只作出处。
 * 合并只在「一个动作能同时解决」时发生（规范 §5.2.3）：
 *  - 缺信息：缺的是同一组字段的网申合成一件（证件号码填一次，20 家都放行）；
 *  - 要登录：登录 / 验证码 / 二次验证一次去浏览器就能处理，合成一件；
 *  - 还没开始填的那几份（批准后材料变了退回待审的）：一句「开始」就全部放行，合成一件；
 *  - 海投填好、检查全部通过的提交：一键全部投出，合成一件（目标岗位和有项要看的仍一家一件）。
 * 不按类型合并：两场笔试是两件事。
 *
 * 「一个对象」（2026-10-30 定）：AskView 不另造 id。单源的用源 id（deadline.id / action.id / handoff.id），
 * 合并的用第一个源的 id，并在 sources 里列出每个源 id，处理时按源逐个落库；在月历、通知中心处理掉的源，
 * 下次派生时自然不再出现。
 *
 * 排序（§5.2.2）：有外部期限的按期限先后；没有的排在后面，按挡住的申请数多少；已经过了时间、只问
 * 「考了吗」的放最后（和 today() 的 OVERDUE_PRIORITY 同一个判断）。
 */
import { companyMarkOf, type CompanyMark } from './company-mark.js'
import type { Repos } from './repos.js'
import { deadlineToToday, type TodayItem } from './surfaces.js'
import type { ActionQueueItem, Deadline, Handoff, InboxItem } from './types.js'
import { PROFILE_FIELDS } from './vault.js'

/**
 * 规范五类 + 已经在今日队列里的四类（过了时间问「考了吗」、面完复盘、不确定是否投出、还没开始填的）。
 * 出错面预留（2026-10-30，等用户定，现在不派生）：failed「N 家没投成」、unsure「这几封我不太确定」。
 */
export type AskKind = 'info' | 'login' | 'deadline' | 'slot' | 'review' | 'start' | 'confirm' | 'attendance' | 'retro' | 'failed' | 'unsure'
export type AskSourceType = 'deadline' | 'action' | 'handoff'
export interface AskSource { type: AskSourceType; id: string }
export interface AskField {
  label: string; /** 给人看的说法：去掉问卷题号「3.」和结尾冒号（label 仍是回填页面用的键） */ text: string; /** 能在卡片里填时写进私密库的字段；null = 写答案库 */ vault_field: string | null; sensitive: boolean; /** 上传类、读回不一致等只能去页面上看的项 */ fillable: boolean
  /** 网页上这一格的可选项（下拉 / 单选）：卡片里让他点选，不用猜网站的写法 */
  options?: string[]
  /** 小芽已经写好的一版（开放题草稿）：卡片里预填，他看一眼确认或改几个字，不从空白开始写 */
  draft?: string
}

export interface AskView {
  id: string
  kind: AskKind
  /** ≤ 12 字左右，如「证件号码」「九方云 · 在线测评」 */
  title: string
  detail?: string
  /** 一个动作能解决的所有申请 */
  application_ids: string[]
  /** 只涉及一份申请时的岗位名（大海报下半写它） */
  role?: string
  /** 涉及的公司（与 application_ids 同序去重；没有申请的截止按标题里的公司名） */
  companies: CompanyMark[]
  /** 合并前的每个源；处理时逐个落库 */
  sources: AskSource[]
  /** 接管类：停下来的那些填表动作，补完后助理按它们从当前页接着填（apply_continue） */
  action_ids?: string[]
  /** 外部期限；null = 没有 */
  due_at: string | null
  /** 已经过了时间（只问考了没有） */
  overdue: boolean
  /** deadline 类：截止的种类（assessment / written_test / interview …） */
  deadline_kind?: string
  url?: string | null
  /** 来自哪封邮件 */
  source?: { inbox_item_id: string; received_at: string }
  /** info：缺的字段（明文只在本机，不进模型上下文） */
  fields?: AskField[]
  /** review：填后检查的数字 */
  review?: { required_filled: number | null; required_total: number | null; gaps: number }
  /** 对话里接着办时发给助理的话（带对象 id） */
  suggest?: string
}

interface AppCtx { company: CompanyMark; jobDeadline: string | null; label: string; role: string }
type Ctx = { apps: Map<string, AppCtx>; nowIso: string; isTarget: (applicationId: string) => boolean }

export interface AskOptions {
  /** 目标岗位（进过面试 / 用户标的）：投前一家一家给你看，不并进「一键投出」。由壳层按目标星判断。 */
  isTarget?: (applicationId: string) => boolean
}

const LOGIN_REASONS = new Set(['login', 'captcha', '2fa', 'user_request'])
const NAME_MAX = 6
const shortName = (s: string) => (s.length > NAME_MAX ? s.slice(0, NAME_MAX) : s)
const parseObj = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try { const v: unknown = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} } catch (e) {
    console.warn(`[career] asks: result_json 解析失败：${e instanceof Error ? e.message : String(e)}`); return {}
  }
}
const records = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function appContext(repos: Repos): Map<string, AppCtx> {
  const map = new Map<string, AppCtx>()
  for (const a of repos.applicationsWithJob()) {
    map.set(a.id, { company: companyMarkOf(a.job.company_name, a.job.company_id), jobDeadline: a.job.deadline, label: `${a.job.company_name ?? ''} ${a.job.title}`.trim(), role: a.job.title })
  }
  return map
}

function companiesOf(ctx: Ctx, appIds: readonly string[]): CompanyMark[] {
  const seen = new Set<string>()
  const out: CompanyMark[] = []
  for (const id of appIds) {
    const c = ctx.apps.get(id)?.company
    if (c && !seen.has(c.name)) { seen.add(c.name); out.push(c) }
  }
  return out
}

/** 没有自己期限的事（缺信息、登录、待投）：挡住的申请里最早、还没过的网申截止就是它的外部期限。 */
function earliestJobDeadline(ctx: Ctx, appIds: readonly string[]): string | null {
  const now = Date.parse(ctx.nowIso)
  let best: number | null = null
  for (const id of appIds) {
    const t = Date.parse(ctx.apps.get(id)?.jobDeadline ?? '')
    if (!Number.isNaN(t) && t > now && (best === null || t < best)) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}

const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x))]

// ---------- 截止 ----------

const INBOX_KIND_FOR: Record<string, string> = { interview: 'interview_invite', assessment: 'assessment', written_test: 'written_test', offer_reply: 'offer' }

/** 截止是哪封邮件带来的：直接连到截止的优先，其次同一份申请、同类的那封。 */
function inboxSourceOf(d: Deadline, inbox: readonly InboxItem[]): AskView['source'] {
  const hit = inbox.find(i => i.linked_type === 'deadline' && i.linked_id === d.id)
    ?? (d.application_id ? inbox.find(i => i.linked_type === 'application' && i.linked_id === d.application_id && i.kind === INBOX_KIND_FOR[d.kind]) : undefined)
  return hit ? { inbox_item_id: hit.id, received_at: hit.created_at } : undefined
}

function deadlineKindOf(item: TodayItem): AskKind {
  if (item.ask === 'attendance') return 'attendance'
  return item.kind === 'interview_retro' ? 'retro' : 'deadline'
}

function deadlineAsk(ctx: Ctx, d: Deadline, item: TodayItem, inbox: readonly InboxItem[]): AskView {
  const appIds = uniq([d.application_id])
  const kind = deadlineKindOf(item)
  const overdue = !!d.due_at && Date.parse(d.due_at) < Date.parse(ctx.nowIso)
  const companyName = d.title.split(/\s*[·・]\s*/)[0]
  return {
    id: d.id, kind, title: item.title, detail: item.detail, application_ids: appIds,
    companies: appIds.length ? companiesOf(ctx, appIds) : [companyMarkOf(companyName)],
    sources: [{ type: 'deadline', id: d.id }],
    // 复盘提示没有外部期限：面试时间已经过了，排在有期限的事之后
    due_at: kind === 'retro' ? null : d.due_at, overdue: kind === 'attendance' || (overdue && kind === 'deadline'),
    deadline_kind: d.kind, url: d.url, source: inboxSourceOf(d, inbox), suggest: item.suggest,
  }
}

/** 截止类：沿用今日队列的取舍（3 天内、过了时间的笔试问考了没、面完一天内提示复盘），只是换成 AskView。 */
function deadlineAsks(repos: Repos, ctx: Ctx): AskView[] {
  const inbox = repos.listInbox()
  const out: AskView[] = []
  for (const d of repos.listDeadlines({ status: 'open_or_missed' })) {
    if (!d.due_at) {
      if (d.status === 'open') out.push(deadlineAsk(ctx, d, { kind: 'deadline', priority: 7, title: d.title, detail: '时间未知，去原邮件或官网确认后补上', ref: { type: 'deadline', id: d.id } }, inbox))
      continue
    }
    const item = deadlineToToday({ ...d, due_at: d.due_at, status: 'open' }, ctx.nowIso)
    if (item) out.push(deadlineAsk(ctx, d, item, inbox))
  }
  return out
}

// ---------- 待批准动作 ----------

const ACTION_TITLE: Partial<Record<ActionQueueItem['kind'], string>> = { submit: '投前过目', send_greeting: '发招呼前过目', send_mail: '发邮件前过目', upload: '上传前过目', answer_open_q: '开放题过目' }

function reviewAsk(ctx: Ctx, a: ActionQueueItem): AskView {
  const appIds = uniq([a.application_id])
  const company = appIds.length ? ctx.apps.get(appIds[0])?.company.name : undefined
  const review = records([parseObj(a.payload_json).review])[0]
  const rows = records(review?.rows)
  return {
    id: a.id, kind: 'review', title: `${company ? shortName(company) + ' · ' : ''}${ACTION_TITLE[a.kind] ?? '等你批准'}`,
    detail: appIds.length ? ctx.apps.get(appIds[0])?.label : undefined,
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: [{ type: 'action', id: a.id }],
    due_at: earliestJobDeadline(ctx, appIds), overdue: false,
    ...(a.kind === 'submit' ? { review: {
      required_filled: typeof review?.requiredFilled === 'number' ? review.requiredFilled : null,
      required_total: typeof review?.requiredTotal === 'number' ? review.requiredTotal : null,
      gaps: rows.filter(r => r.status && r.status !== 'ok' && r.status !== 'empty_optional').length,
    } } : {}),
  }
}

/** 还没开始填的几份（批准后材料变了退回待审）：一句「开始」全部放行，合成一件。没有「待投清单」：框选确认就开始。 */
function startAsk(ctx: Ctx, actions: readonly ActionQueueItem[]): AskView | null {
  if (!actions.length) return null
  const appIds = uniq(actions.map(a => a.application_id))
  return {
    id: actions[0].id, kind: 'start', title: `${actions.length} 家等你说开始`, detail: '开始后会填到提交前停下',
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: actions.map(a => ({ type: 'action' as const, id: a.id })),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false,
  }
}

/** 海投里填后检查全部通过、没有要你看的项的提交：一键全部投出，合成一件（用户 2026-10-30「要一个一键按钮」）。 */
const isCleanSubmit = (ctx: Ctx, r: AskView) => !!r.review && r.review.gaps === 0 && r.review.required_total !== null && !r.application_ids.some(ctx.isTarget)

function sendAllAsk(ctx: Ctx, reviews: readonly AskView[]): AskView {
  const appIds = uniq(reviews.flatMap(r => r.application_ids))
  return {
    id: reviews[0].id, kind: 'review', title: `${appIds.length} 家填好了`, detail: '必填都填好并核对过，没有要你看的项',
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: reviews.flatMap(r => r.sources),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false, review: { required_filled: null, required_total: null, gaps: 0 },
  }
}

function actionAsks(repos: Repos, ctx: Ctx): AskView[] {
  const pending = repos.listActions('pending_review')
  const start = startAsk(ctx, pending.filter(a => a.kind === 'fill_form'))
  const reviews = pending.filter(a => a.kind !== 'fill_form').map(a => reviewAsk(ctx, a))
  const clean = reviews.filter(r => pending.find(a => a.id === r.id)?.kind === 'submit' && isCleanSubmit(ctx, r))
  const merged = clean.length > 1 ? [sendAllAsk(ctx, clean)] : []
  const rest = merged.length ? reviews.filter(r => !clean.includes(r)) : reviews
  return [...(start ? [start] : []), ...merged, ...rest]
}

// ---------- 接管 ----------

const PROFILE_BY_KEY = new Map(PROFILE_FIELDS.map(f => [f.field, f]))
const UNFILLABLE = new Set(['mismatch', 'unverified', 'upload_unconfirmed', 'site_error'])

/** 填表停下时缺的字段：gate.gaps 是全集；needsUser 带 key 的映射到私密库字段。 */
function missingFields(action: ActionQueueItem | undefined): AskField[] {
  const result = parseObj(action?.result_json ?? null)
  const gate = records([result.gate])[0]
  const keyOf = new Map(records(result.needsUser).map(p => [strOf(p.label), strOf(p.key)]))
  const optionsOf = new Map(records(result.needsUser).map(p => [strOf(p.label), Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : []]))
  const files = new Set(records(result.fields).filter(f => f.type === 'file').map(f => strOf(f.label)))
  const draftOf = new Map(records(result.drafts).filter(d => typeof d.value === 'string' && d.value.trim()).map(d => [strOf(d.label), String(d.value)]))
  const fields: AskField[] = []
  for (const g of records(gate?.gaps)) {
    const label = strOf(g.label)
    if (!label || g.required === false || fields.some(f => f.label === label)) continue
    const def = PROFILE_BY_KEY.get(keyOf.get(label) ?? '')
    const options = optionsOf.get(label) ?? []
    const draft = draftOf.get(label)
    fields.push({ label, text: askFieldText(label), vault_field: def?.field ?? null, sensitive: def?.sensitive ?? false, fillable: !files.has(label) && !UNFILLABLE.has(String(g.status)), ...(options.length && !def?.sensitive ? { options } : {}), ...(draft && !def?.sensitive ? { draft } : {}) })
  }
  return fields
}

/** 问卷题目带的题号和结尾冒号（「3.您的年龄」「4、学校名称：」）不给人看（2026-11-02 等你卡标题成了「3.您的年龄等 4 项」）。 */
export function askFieldText(label: string): string {
  return label.replace(/^\s*\d+\s*[.、．)）]\s*/, '').replace(/[：:]\s*$/, '').trim() || label
}

interface HandoffRow { h: Handoff; appId: string | null; action?: ActionQueueItem }

function infoAsks(ctx: Ctx, rows: readonly HandoffRow[]): AskView[] {
  const groups = new Map<string, { rows: HandoffRow[]; fields: AskField[] }>()
  for (const r of rows) {
    const fields = missingFields(r.action)
    const key = fields.length ? fields.map(f => f.label).sort().join('|') : `msg:${r.h.message ?? r.h.id}`
    const g = groups.get(key) ?? { rows: [], fields }
    g.rows.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].map(({ rows: rs, fields }) => {
    const appIds = uniq(rs.map(r => r.appId))
    const names = fields.map(f => f.text)
    return {
      id: rs[0].h.id, kind: 'info' as const,
      title: names.length ? (names.length > 1 ? `${names[0]}等 ${names.length} 项` : names[0]) : '还差几项要你补',
      detail: names.length ? undefined : rs[0].h.message ?? undefined,
      application_ids: appIds, companies: companiesOf(ctx, appIds), sources: rs.map(r => ({ type: 'handoff' as const, id: r.h.id })),
      action_ids: uniq(rs.map(r => r.h.action_id)), due_at: earliestJobDeadline(ctx, appIds), overdue: false, fields,
    }
  })
}

function loginAsk(ctx: Ctx, rows: readonly HandoffRow[]): AskView | null {
  if (!rows.length) return null
  const appIds = uniq(rows.map(r => r.appId))
  const allLogin = rows.every(r => r.h.reason === 'login')
  const one = appIds.length === 1 ? ctx.apps.get(appIds[0])?.company.name : undefined
  const title = one ? `${shortName(one)} · ${allLogin ? '要登录' : '等你过一下'}` : `${appIds.length || rows.length} 个网站${allLogin ? '要你登录' : '等你过一下'}`
  return {
    id: rows[0].h.id, kind: 'login', title, detail: allLogin ? '登录一次，之后自动投' : '登录、验证码一次去浏览器处理完',
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: rows.map(r => ({ type: 'handoff' as const, id: r.h.id })),
    action_ids: uniq(rows.map(r => r.h.action_id)), due_at: earliestJobDeadline(ctx, appIds), overdue: false,
  }
}

function singleHandoffAsk(ctx: Ctx, r: HandoffRow, kind: 'deadline' | 'confirm'): AskView {
  const appIds = uniq([r.appId])
  const company = appIds.length ? ctx.apps.get(appIds[0])?.company.name : undefined
  const what = kind === 'confirm' ? '投出了吗' : '在线测评'
  return {
    id: r.h.id, kind, title: company ? `${shortName(company)} · ${what}` : what, detail: r.h.message ?? undefined,
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: [{ type: 'handoff', id: r.h.id }], action_ids: uniq([r.h.action_id]),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false, ...(kind === 'deadline' ? { deadline_kind: 'assessment' } : {}),
  }
}

function handoffAsks(repos: Repos, ctx: Ctx): AskView[] {
  const rows: HandoffRow[] = repos.openHandoffs().map(h => {
    const action = h.action_id ? repos.getAction(h.action_id) : undefined
    return { h, action, appId: action?.application_id ?? null }
  })
  const login = loginAsk(ctx, rows.filter(r => LOGIN_REASONS.has(r.h.reason)))
  return [
    ...infoAsks(ctx, rows.filter(r => r.h.reason === 'missing_info')),
    ...(login ? [login] : []),
    ...rows.filter(r => r.h.reason === 'assessment').map(r => singleHandoffAsk(ctx, r, 'deadline')),
    ...rows.filter(r => r.h.reason === 'submit_confirm').map(r => singleHandoffAsk(ctx, r, 'confirm')),
  ]
}

/** 网申里卡在测评的接管，和同一份申请上已经记下的测评截止是同一件事：并进那件，不另出一件。 */
function foldAssessmentHandoffs(asks: AskView[]): AskView[] {
  const out: AskView[] = []
  for (const a of asks) {
    const twin = a.kind === 'deadline' && a.sources[0]?.type === 'handoff'
      ? out.find(o => o.sources[0]?.type === 'deadline' && o.deadline_kind === 'assessment' && o.application_ids.some(id => a.application_ids.includes(id)))
      : undefined
    if (twin) twin.sources.push(...a.sources)
    else out.push(a)
  }
  return out
}

// ---------- 排序与入口 ----------

/** 有期限的在前（越急越前），没期限的按挡住的申请数，已经过了时间的放最后。 */
export function compareAsks(a: AskView, b: AskView): number {
  const group = (x: AskView) => (x.overdue ? 2 : x.due_at ? 0 : 1)
  const ga = group(a); const gb = group(b)
  if (ga !== gb) return ga - gb
  if (ga === 0) return Date.parse(a.due_at!) - Date.parse(b.due_at!)
  if (ga === 1) return b.application_ids.length - a.application_ids.length || a.title.localeCompare(b.title)
  return (b.due_at ?? '').localeCompare(a.due_at ?? '')
}

/** 现在要你的事（已合并、已排序）。 */
export function buildAsks(repos: Repos, nowIso: string, opts: AskOptions = {}): AskView[] {
  const ctx: Ctx = { apps: appContext(repos), nowIso, isTarget: opts.isTarget ?? (() => false) }
  const asks = foldAssessmentHandoffs([...deadlineAsks(repos, ctx), ...actionAsks(repos, ctx), ...handoffAsks(repos, ctx)])
  for (const a of asks) if (a.application_ids.length === 1) a.role = ctx.apps.get(a.application_ids[0])?.role
  return asks.sort(compareAsks)
}
