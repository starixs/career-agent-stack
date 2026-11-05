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
import { appContext, companiesOf, earliestJobDeadline, parseObj, records, shortName, strOf, uniq, type AskField, type AskKind, type AskView, type Ctx } from './ask-context.js'
import { failedMailAsk, isMailReviewKind, mailReviewAsks } from './asks-mail.js'
import { companyMarkOf } from './company-mark.js'
import { fillFailReason, isJobClosedFailure } from './fill-retry.js'
import type { Repos } from './repos.js'
import { deadlineToToday, type TodayItem } from './surfaces.js'
import type { ActionQueueItem, Deadline, Handoff, InboxItem } from './types.js'
import { PROFILE_FIELDS, vaultTokensToMarks } from './vault.js'

export type { AskField, AskKind, AskMail, AskMailFailed, AskMailPurpose, AskSource, AskSourceType, AskView } from './ask-context.js'
export { ASK_MAIL_PURPOSES } from './ask-context.js'

export interface AskOptions {
  /** 目标岗位（进过面试 / 用户标的）：投前一家一家给你看，不并进「一键投出」。由壳层按目标星判断。 */
  isTarget?: (applicationId: string) => boolean
}

const LOGIN_REASONS = new Set(['login', 'captcha', '2fa', 'user_request'])

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

const ACTION_TITLE: Partial<Record<ActionQueueItem['kind'], string>> = { submit: '投前过目', send_greeting: '发招呼前过目', upload: '上传前过目', answer_open_q: '开放题过目' }

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

/** 还没开始的那一步：网申的填表、邮件投递的写邮件（都是批准即开始；批准后退回待审才会出现在这里）。 */
const NOT_STARTED_KINDS: ReadonlySet<ActionQueueItem['kind']> = new Set(['fill_form', 'draft_mail'])

function actionAsks(repos: Repos, ctx: Ctx): AskView[] {
  const pending = repos.listActions('pending_review')
  const start = startAsk(ctx, pending.filter(a => NOT_STARTED_KINDS.has(a.kind)))
  // 发邮件前过目按用途分组（asks-mail.ts），不走通用的一封一件
  const reviews = pending.filter(a => !NOT_STARTED_KINDS.has(a.kind) && !isMailReviewKind(a)).map(a => reviewAsk(ctx, a))
  const clean = reviews.filter(r => pending.find(a => a.id === r.id)?.kind === 'submit' && isCleanSubmit(ctx, r))
  const merged = clean.length > 1 ? [sendAllAsk(ctx, clean)] : []
  const rest = merged.length ? reviews.filter(r => !clean.includes(r)) : reviews
  return [...(start ? [start] : []), ...merged, ...rest, ...mailReviewAsks(ctx, pending)]
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
  // 灰着、在等前一格的（专业等学院）：前一格定了续填会自动接上，不问他（引擎 needs.explainWaiting 标的 waitsFor）
  const waiting = new Set(records(result.needsUser).filter(p => strOf(p.waitsFor)).map(p => strOf(p.label)))
  const uncertain = new Set(records(result.needsUser).filter(p => ENGINE_UNSURE_CODES.has(String(p.code))).map(p => strOf(p.label)))
  const fields: AskField[] = []
  for (const g of records(gate?.gaps)) {
    const label = strOf(g.label)
    if (!label || g.required === false || waiting.has(label) || fields.some(f => f.label === label)) continue
    const def = PROFILE_BY_KEY.get(keyOf.get(label) ?? '')
    const options = optionsOf.get(label) ?? []
    const rawDraft = draftOf.get(label)
    const draft = rawDraft ? vaultTokensToMarks(rawDraft) : undefined
    const text = askFieldText(label)
    // 认不出这一格问的是什么（题号「03」、导航栏、别的网站的标题）：是我们的识别问题，不让他对着「03」猜，只能去页面上看
    const readable = isReadableLabel(text) && !uncertain.has(label)
    fields.push({ label, text: readable ? text : UNREADABLE_TEXT, vault_field: readable ? def?.field ?? null : null, sensitive: def?.sensitive ?? false, fillable: readable && !files.has(label) && !UNFILLABLE.has(String(g.status)), ...(readable && options.length && !def?.sensitive ? { options } : {}), ...(readable && draft && !def?.sensitive ? { draft } : {}) })
  }
  return fields
}

/** 认不出名字的格子给人看的说法。 */
export const UNREADABLE_TEXT = '网页上没写清是什么的一格'
/** 引擎自己报的「这格的标签不可靠」。 */
const ENGINE_UNSURE_CODES = new Set(['label_uncertain'])
/** 引擎兜底时给的占位名、或者 drive-outcome 的「没认出名字的字段」：都不是给人看的名字。 */
const PLACEHOLDER_LABELS = new Set(['没认出名字的字段', '填后检查', '必填项核对'])
/** 一格的名字能不能直接给人看：有至少两个字、不是题号 / 区号、不像整排导航或别的网站标题。 */
export function isReadableLabel(text: string): boolean {
  const t = text.trim()
  if (!t || PLACEHOLDER_LABELS.has(t)) return false
  if (!/[\p{L}]{2,}/u.test(t.replace(/\d+/g, ''))) return false
  if (/\b[a-z0-9-]+\.(ai|com|cn|net|io|org)\b/i.test(t)) return false
  // 一排用空格隔开的中文短词（「企业招聘 博客 关于offer求索」「首页 招聘职位 …」）是导航栏，不是一格的名字；英文标签「Date of Birth」不算
  if (t.split(/\s+/).filter(w => /\p{Script=Han}/u.test(w)).length >= 3 || t.split(/\s+/).length >= 5) return false
  return t.length <= 40
}

/** 问卷题目带的题号和结尾冒号（「3.您的年龄」「4、学校名称：」）不给人看（2026-11-02 等你卡标题成了「3.您的年龄等 4 项」）。 */
export function askFieldText(label: string): string {
  return label.replace(/^\s*\d+\s*[.、．)）]\s*/, '').replace(/[：:]\s*$/, '').trim() || label
}

interface HandoffRow { h: Handoff; appId: string | null; action?: ActionQueueItem }

/** 缺信息那件的标题。全是小芽写好草稿的开放题时说「写好了，看一眼」（E#12），不像又让他从头填。 */
function infoTitle(fields: readonly AskField[], names: readonly string[], unreadable: number, one: string | undefined): string {
  const drafts = fields.filter(f => f.draft).length
  if (drafts && drafts === fields.length) return `${drafts} 道开放题写好了，看一眼`
  if (names.length) return names.length > 1 ? `${names[0]}等 ${names.length} 项` : names[0]
  return unreadable ? `${one ? `${shortName(one)} · ` : ''}页面上有 ${unreadable} 处要你看` : '还差几项要你补'
}

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
    const names = fields.filter(f => f.text !== UNREADABLE_TEXT).map(f => f.text)
    const unreadable = fields.length - names.length
    const one = appIds.length === 1 ? ctx.apps.get(appIds[0])?.company.name : undefined
    return {
      id: rs[0].h.id, kind: 'info' as const,
      title: infoTitle(fields, names, unreadable, one),
      detail: names.length || unreadable ? undefined : rs[0].h.message ?? undefined,
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
  const choices = rows.filter(r => r.h.reason === 'user_request' && dialogOf(r.action))
  const login = loginAsk(ctx, rows.filter(r => LOGIN_REASONS.has(r.h.reason) && !choices.includes(r)))
  return [
    ...infoAsks(ctx, rows.filter(r => r.h.reason === 'missing_info')),
    ...choices.map(r => choiceAsk(ctx, r, dialogOf(r.action)!)),
    ...(login ? [login] : []),
    ...rows.filter(r => r.h.reason === 'assessment').map(r => singleHandoffAsk(ctx, r, 'deadline')),
    ...rows.filter(r => r.h.reason === 'submit_confirm').map(r => singleHandoffAsk(ctx, r, 'confirm')),
  ]
}

/** 填表停在一个拿不准的弹窗上（引擎带回了它问的话和按钮）。 */
function dialogOf(action: ActionQueueItem | undefined): { text: string; buttons: string[] } | null {
  const d = parseObj(action?.result_json ?? null).dialog as { text?: unknown; buttons?: unknown } | undefined
  const text = strOf(d?.text)
  const buttons = Array.isArray(d?.buttons) ? d.buttons.filter((b): b is string => typeof b === 'string' && !!b.trim()) : []
  return text && buttons.length ? { text, buttons } : null
}

/** 弹窗的第一句话当问题（后面常是长长的选项列表）。 */
const QUESTION_MAX = 40
function choiceAsk(ctx: Ctx, r: HandoffRow, dialog: { text: string; buttons: string[] }): AskView {
  const appIds = uniq([r.appId])
  const company = appIds.length ? ctx.apps.get(appIds[0])?.company.name : undefined
  const question = (dialog.text.split(/[。？?！!\n]/)[0] ?? dialog.text).replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX)
  return {
    id: r.h.id, kind: 'choice', title: company ? `${shortName(company)} · ${question}` : question,
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: [{ type: 'handoff', id: r.h.id }], action_ids: uniq([r.h.action_id]),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false, choice: { question: dialog.text, options: dialog.buttons },
  }
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

// ---------- 没填成 ----------

/** 理由最多并列几种：多了卡上一行放不下，看清一两种就够他决定再试还是自己来。 */
const MAX_FAIL_REASONS = 2

/** 每份投递最近一次填表动作是失败的、投递还停在 blocked（没被重试、接管或改道）的那几个动作。 */
function failedFills(repos: Repos): ActionQueueItem[] {
  const latest = new Map<string, ActionQueueItem>()
  for (const a of repos.listActions()) {
    if (a.kind !== 'fill_form' || !a.application_id) continue
    const prev = latest.get(a.application_id)
    if (!prev || prev.updated_at < a.updated_at) latest.set(a.application_id, a)
  }
  // 岗位已结束招聘的不算没填成（E#1）：运行器会把它关掉，对话里跑的那一份还没关时这里也不出
  return [...latest].filter(([appId, a]) => a.status === 'failed' && repos.getApplication(appId)?.stage === 'blocked' && !isJobClosedFailure(a)).map(([, a]) => a)
    .sort((x, y) => x.created_at.localeCompare(y.created_at))
}

/** 填表失败、自动再试一次也没成的：合成一件（「再试一次」一个动作就能把它们全放回队列）。 */
function failedAsk(repos: Repos, ctx: Ctx): AskView | null {
  const actions = failedFills(repos)
  if (!actions.length) return null
  const appIds = uniq(actions.map(a => a.application_id))
  const reasons = uniq(actions.map(fillFailReason))
  const one = actions.length === 1 ? strOf(parseObj(actions[0].payload_json).url) : undefined
  return {
    id: actions[0].id, kind: 'failed', title: `${appIds.length} 家没填成`, detail: reasons.slice(0, MAX_FAIL_REASONS).join('、'),
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: actions.map(a => ({ type: 'action' as const, id: a.id })),
    action_ids: actions.map(a => a.id), due_at: earliestJobDeadline(ctx, appIds), overdue: false,
    ...(one ? { url: one } : {}),
  }
}

// ---------- 排序与入口 ----------

/** 有期限的在前（越急越前），没期限的按挡住的申请数，已经过了时间的放最后。 */
export function compareAsks(a: AskView, b: AskView): number {
  const group = (x: AskView) => (x.overdue ? 2 : x.due_at ? 0 : 1)
  const ga = group(a); const gb = group(b)
  if (ga !== gb) return ga - gb
  if (ga === 0) return Date.parse(a.due_at!) - Date.parse(b.due_at!)
  // 没期限的里面，填好等投前过目的排最前：点一下就投出去，是他最想办完的事（2026-11-03：两份过目被「48 个网站等你登录」压在后面，找不到）
  const ready = (x: AskView) => (x.kind === 'review' ? 0 : 1)
  if (ga === 1) return ready(a) - ready(b) || b.application_ids.length - a.application_ids.length || a.title.localeCompare(b.title)
  return (b.due_at ?? '').localeCompare(a.due_at ?? '')
}

/** 现在要你的事（已合并、已排序）。 */
export function buildAsks(repos: Repos, nowIso: string, opts: AskOptions = {}): AskView[] {
  const ctx: Ctx = { apps: appContext(repos), nowIso, isTarget: opts.isTarget ?? (() => false) }
  const failed = failedAsk(repos, ctx)
  const asks = foldAssessmentHandoffs([...deadlineAsks(repos, ctx), ...actionAsks(repos, ctx), ...handoffAsks(repos, ctx), ...(failed ? [failed] : []), ...failedMailAsk(repos, ctx)])
  for (const a of asks) if (a.application_ids.length === 1) a.role = ctx.apps.get(a.application_ids[0])?.role
  return asks.sort(compareAsks)
}
