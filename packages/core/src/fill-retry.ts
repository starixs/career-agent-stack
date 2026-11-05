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

/** 填表失败后调用：没试过就标记并放回队列，试过就不再试。调用方负责叫醒后台运行器。 */
export function autoRetryFailedFill(repos: Repos, actionId: string): AutoRetryResult {
  const action = repos.getAction(actionId)
  if (!action || action.kind !== 'fill_form' || action.status !== 'failed' || !action.application_id) return 'not_retryable'
  const app = repos.getApplication(action.application_id)
  if (!app) return 'not_retryable'
  if (app.retry_strategy === FILL_AUTO_RETRIED) return 'exhausted'
  repos.db.update('application', app.id, { retry_strategy: FILL_AUTO_RETRIED, updated_at: new Date().toISOString() })
  return repos.retryFailedFill(actionId) ? 'retrying' : 'not_retryable'
}

const parseResult = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch (e) {
    console.warn(`[career] fill-retry: result_json 解析失败：${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
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

/** 引擎 / 浏览器的错误原文 → 给学生看的一句人话（按先后匹配第一条）。 */
const FAIL_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/timeout|timed out|超时|打不开|没打开|navigation|net::|err_/i, '页面一直没打开'],
  [/selector|locator|element|field|字段|填不上|找不到.{0,6}(输入|控件|选项|按钮)/i, '有一格我填不上'],
  [/没有返回填表结果|浏览器|browser|HTTP 5\d\d/i, '浏览器中途断了'],
]
const BLOCKED_REASON = '网站把这一步拦下了'
const DEFAULT_REASON = '网站那边出了点问题'

/** 上一次失败的原因（人话）。summary.status = blocked 的是网站拦下，其余按错误原文归类。 */
export function fillFailReason(action: Pick<ActionQueueItem, 'result_json'>): string {
  const result = parseResult(action.result_json)
  const summary = result.summary && typeof result.summary === 'object' && !Array.isArray(result.summary) ? result.summary as Record<string, unknown> : {}
  const error = lastFillError(action) ?? ''
  const hit = FAIL_REASONS.find(([re]) => re.test(error))
  if (hit) return hit[1]
  return summary.status === 'blocked' ? BLOCKED_REASON : DEFAULT_REASON
}
