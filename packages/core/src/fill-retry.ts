/**
 * 填表失败的处理（出错面，2026-11-05 定）：失败一次先自动再试一次；再失败才出一件「N 家没填成」进等你。
 *
 * 「试过一次」记在 application.retry_strategy（建表时就有、此前没人用的列），不加迁移：
 * 一份投递只自动重试一次；用户在等你卡上点「再试一次」也算用过，再失败直接回到等你，不会自动循环。
 */
import type { Repos } from './repos.js'
import type { ActionQueueItem } from './types.js'

/** application.retry_strategy 的取值：这份投递填表失败后已经自动再试过一次。 */
export const FILL_AUTO_RETRIED = 'fill_auto_retried_once'

/**
 * retrying：已放回队列（approved），后台会再填一次；
 * exhausted：这份投递已经试过一次，交给等你；
 * not_retryable：不是失败的填表动作，或批准已失效（内容改过）没法原样重跑——也交给等你。
 */
export type AutoRetryResult = 'retrying' | 'exhausted' | 'not_retryable'

/** 开跑前材料包没备出来（运行器 preparePacket 失败）的错误码：不是瞬时、不自动再试，原因原样进「N 家没填成」。 */
export const PACKET_FAILED_CODE = 'PACKET_FAILED'

/** 填表失败后调用：没试过就标记并放回队列，试过就不再试。调用方负责叫醒后台运行器。 */
export function autoRetryFailedFill(repos: Repos, actionId: string): AutoRetryResult {
  const action = repos.getAction(actionId)
  if (!action || action.kind !== 'fill_form' || action.status !== 'failed' || !action.application_id) return 'not_retryable'
  // 材料包没备出来（PDF 导不出 / 简历不在）：原样再跑一次还是一样，交给等你，由他点「再试一次」
  if (failCodeOf(action) === PACKET_FAILED_CODE) return 'not_retryable'
  const app = repos.getApplication(action.application_id)
  if (!app) return 'not_retryable'
  if (app.retry_strategy === FILL_AUTO_RETRIED) return 'exhausted'
  repos.db.update('application', app.id, { retry_strategy: FILL_AUTO_RETRIED, updated_at: new Date().toISOString() })
  return repos.retryFailedFill(actionId) ? 'retrying' : 'not_retryable'
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const parseResult = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return isRecord(v) ? v : {}
  } catch (e) {
    console.warn(`[career] fill-retry: result_json 解析失败：${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
}

/** 失败落库时带的错误码（drive-outcome fail 写进 result_json.code）。 */
const failCodeOf = (action: Pick<ActionQueueItem, 'result_json'>): string | null => {
  const code = parseResult(action.result_json).code
  return typeof code === 'string' ? code : null
}

/** 动作上一次失败留下的错误原文（result_json.error）；没有返回 null。 */
export function lastFillError(action: Pick<ActionQueueItem, 'result_json'>): string | null {
  const error = parseResult(action.result_json).error
  return typeof error === 'string' && error.trim() ? error.trim() : null
}

/** 正在「再试一次」：失败过（还留着上次的错误）、已放回队列或正在填、所在投递标了试过一次。 */
export function isFillRetrying(repos: Repos, action: ActionQueueItem): boolean {
  if (action.kind !== 'fill_form' || (action.status !== 'approved' && action.status !== 'executing') || !action.application_id) return false
  if (!lastFillError(action)) return false
  return repos.getApplication(action.application_id)?.retry_strategy === FILL_AUTO_RETRIED
}

/** 引擎的话 / 弹窗里写着这个岗位已经不招了（风险 E#1）：这些字只说这一家，宽松认。 */
export const JOB_CLOSED_RX = /已结束|已截止|停止招聘|招满/
/**
 * 页面正文（没找到表单时整页前 2k 字）只认明确说岗位 / 报名结束的句式：门户页常有「往期已结束」「已截止岗位不显示」，
 * 「招聘截止时间：12-01」只是写着截止日。
 */
export const JOB_CLOSED_PAGE_RX = /(该|本|此)?(岗位|职位|招聘)(已)?(结束|截止|关闭)(?![时日])|停止招聘|已招满|报名已(结束|截止)/
/** 引擎说页面上没找到可填的表单（与 applyability.ts 的 NO_FORM 同一类说法）。 */
export const NO_FORM_RX = /没有可填写的(网申)?表单|没有找到可填写的网申表单|没有可填写的字段/
/** 没找到表单给学生看的一句（风险 E#6）：多半是链接换了，「打开看看」去页面上看。 */
export const NO_FORM_REASON = '这家的网申页没找到表单（可能换了链接）'
export const JOB_CLOSED_REASON = '岗位已结束招聘'

const textOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * 岗位已结束的依据：message = 错误原文、引擎的话、弹窗字里写着（宽松式）；page = 只在页面正文里按严格句式认出；没有为 null。
 */
export function jobClosedEvidence(action: Pick<ActionQueueItem, 'result_json'>): 'message' | 'page' | null {
  const result = parseResult(action.result_json)
  const summary = isRecord(result.summary) ? result.summary : {}
  const dialog = isRecord(summary.dialog) ? summary.dialog.text : undefined
  const said = [result.error, summary.message, summary.userAction, dialog].map(textOf).filter((t): t is string => !!t)
  if (said.some(t => JOB_CLOSED_RX.test(t))) return 'message'
  const page = textOf(summary.pageText)
  return page && JOB_CLOSED_PAGE_RX.test(page) ? 'page' : null
}

/** 这次填表失败是因为岗位已经结束招聘（见 jobClosedEvidence）。 */
export function isJobClosedFailure(action: Pick<ActionQueueItem, 'result_json'>): boolean {
  return jobClosedEvidence(action) !== null
}

/**
 * 填表失败后先调：岗位已结束招聘就把投递关掉（skip，备注已结束），返回 true；调用方不再自动重试、不计入「没填成」。
 * 只有引擎 / 弹窗亲口说了才把岗位标关闭（source_status='closed'）；只凭页面正文认出的不动岗位库，免得一页门户字误杀岗位。
 * 不是这种失败返回 false，什么都不改。
 */
export function closeIfJobEnded(repos: Repos, actionId: string): boolean {
  const action = repos.getAction(actionId)
  const evidence = action?.kind === 'fill_form' && action.status === 'failed' ? jobClosedEvidence(action) : null
  if (!action || !evidence) return false
  const app = action.application_id ? repos.getApplication(action.application_id) : undefined
  if (app) {
    if (evidence === 'message') repos.db.update('job', app.job_id, { source_status: 'closed', updated_at: new Date().toISOString() })
    try { repos.transition(app.id, 'skip', JOB_CLOSED_REASON, { blocker_reason: JOB_CLOSED_REASON, next_action: null }) } catch (e) {
      console.warn(`[career] fill-retry: 投递 ${app.id} 关不掉（${app.stage}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`[career] job-closed action=${actionId} app=${action.application_id ?? '?'} evidence=${evidence}`)
  return true
}

/** 引擎 / 浏览器的错误原文 → 给学生看的一句人话（按先后匹配第一条）。 */
const FAIL_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [NO_FORM_RX, NO_FORM_REASON],
  [/timeout|timed out|超时|打不开|没打开|navigation|net::|err_/i, '页面一直没打开'],
  [/selector|locator|element|field|字段|填不上|找不到.{0,6}(输入|控件|选项|按钮)/i, '有一格我填不上'],
  [/没有返回填表结果|浏览器|browser|HTTP 5\d\d/i, '浏览器中途断了'],
]
const BLOCKED_REASON = '网站把这一步拦下了'
const DEFAULT_REASON = '网站那边出了点问题'

/** 上一次失败的原因（人话）。summary.status = blocked 的是网站拦下，其余按错误原文归类。 */
export function fillFailReason(action: Pick<ActionQueueItem, 'result_json'>): string {
  const result = parseResult(action.result_json)
  const summary = isRecord(result.summary) ? result.summary : {}
  const error = lastFillError(action) ?? ''
  if (isJobClosedFailure(action)) return JOB_CLOSED_REASON
  // 材料包没备出来：原因是我们自己写的人话（「简历 PDF 没导出来」），原样给他看
  if (failCodeOf(action) === PACKET_FAILED_CODE && error) return error
  const hit = FAIL_REASONS.find(([re]) => re.test(error))
  if (hit) return hit[1]
  return summary.status === 'blocked' ? BLOCKED_REASON : DEFAULT_REASON
}
