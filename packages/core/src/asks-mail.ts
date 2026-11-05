/**
 * 邮件投递在「等你」里的几件（face-mail-apply 2026-11-05；规范 CAREER_INTELLIGENT_UI.md §5.2）：
 *  - 写好待发的投递邮件：1 封 →「{公司} · 邮件写好了」；≥2 封合成「N 封邮件写好了」（一次过目、一键发出）。
 *    跟进 / 回信一封一件，不并进投递那件。kind 仍是 review，AskView.mail 只带用途和动作 id（没有邮件内容）。
 *  - 发送失败：「N 封没发出去」（再发一次 = 放回待审让他再点发出，发送永远过人）；
 *  - 写邮件失败：「N 封没写成」（再试一次 = 放回队列重新写）。
 * 每份投递只看最近一个邮件动作：已经重写 / 重发过的旧失败不再出现。
 */
import { ASK_MAIL_PURPOSES, companiesOf, earliestJobDeadline, parseObj, shortName, strOf, uniq, type AskMailPurpose, type AskView, type Ctx } from './ask-context.js'
import type { Repos } from './repos.js'
import type { ActionQueueItem } from './types.js'

/** 发邮件前过目：待审的 send_mail 都按用途分组派生。 */
export const isMailReviewKind = (a: Pick<ActionQueueItem, 'kind'>): boolean => a.kind === 'send_mail'

/** 这封邮件的用途；老的 mail_compose 动作没写用途，都是投递邮件。 */
const isPurpose = (v: unknown): v is AskMailPurpose => typeof v === 'string' && (ASK_MAIL_PURPOSES as readonly string[]).includes(v)
export function mailPurposeOf(a: Pick<ActionQueueItem, 'payload_json'>): AskMailPurpose {
  const p = parseObj(a.payload_json).purpose
  return isPurpose(p) ? p : 'apply'
}

const ONE_TITLE: Record<AskMailPurpose, string> = { apply: '邮件写好了', followup: '跟进邮件写好了', reply: '回信写好了' }

function mailAsk(ctx: Ctx, actions: readonly ActionQueueItem[], purpose: AskMailPurpose, title: string): AskView {
  const appIds = uniq(actions.map(a => a.application_id))
  const ids = actions.map(a => a.id)
  return {
    id: ids[0], kind: 'review', title,
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: ids.map(id => ({ type: 'action' as const, id })),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false, mail: { purpose, action_ids: ids },
  }
}

function oneTitle(ctx: Ctx, a: ActionQueueItem, purpose: AskMailPurpose): string {
  const company = a.application_id ? ctx.apps.get(a.application_id)?.company.name : undefined
  return `${company ? `${shortName(company)} · ` : ''}${ONE_TITLE[purpose]}`
}

/** 待审的 send_mail → 等你里的几件：投递邮件合成一件，跟进 / 回信一封一件。 */
export function mailReviewAsks(ctx: Ctx, pending: readonly ActionQueueItem[]): AskView[] {
  const mails = pending.filter(isMailReviewKind)
  const apply = mails.filter(a => mailPurposeOf(a) === 'apply')
  const out: AskView[] = []
  if (apply.length === 1) out.push(mailAsk(ctx, apply, 'apply', oneTitle(ctx, apply[0], 'apply')))
  if (apply.length > 1) out.push(mailAsk(ctx, apply, 'apply', `${apply.length} 封邮件写好了`))
  for (const a of mails.filter(m => mailPurposeOf(m) !== 'apply')) out.push(mailAsk(ctx, [a], mailPurposeOf(a), oneTitle(ctx, a, mailPurposeOf(a))))
  return out
}

// ---------- 没发出去 / 没写成 ----------

/** 投递已经走完（投出、关掉）的不再提它的邮件失败。 */
const SETTLED_STAGES: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'discarded', 'skip'])
/** 邮箱授权的错：授权码失效 / 被改，要重新连邮箱，再发一次没用。 */
const AUTH_ERROR_RX = /授权|auth|535|credential|login|密码/i
export const MAIL_AUTH_FAILED_REASON = '邮箱授权失效了，重新连一下邮箱'
export const MAIL_SEND_FAILED_REASON = '发送没成功'
export const MAIL_DRAFT_FAILED_REASON = '没写成'
/** 理由最多并列几种（和「N 家没填成」同一个取舍）。 */
const MAX_FAIL_REASONS = 2

const errorOf = (a: ActionQueueItem): string => strOf(parseObj(a.result_json).error) ?? ''

/** 发送失败给人看的一句：授权问题单独说（指向重新连邮箱），其余一律「发送没成功」。 */
export function mailSendFailReason(a: ActionQueueItem): string {
  return AUTH_ERROR_RX.test(errorOf(a)) ? MAIL_AUTH_FAILED_REASON : MAIL_SEND_FAILED_REASON
}

/** 每份投递（没有投递的按动作）最近一个邮件动作。 */
function latestMailActions(repos: Repos): ActionQueueItem[] {
  const latest = new Map<string, ActionQueueItem>()
  for (const a of repos.listActions()) {
    if (a.kind !== 'send_mail' && a.kind !== 'draft_mail') continue
    const key = a.application_id ?? a.id
    const prev = latest.get(key)
    if (!prev || prev.created_at < a.created_at || (prev.created_at === a.created_at && prev.updated_at < a.updated_at)) latest.set(key, a)
  }
  return [...latest.values()].filter(a => a.status === 'failed' && !(a.application_id && SETTLED_STAGES.has(repos.getApplication(a.application_id)?.stage ?? '')))
    .sort((x, y) => x.created_at.localeCompare(y.created_at))
}

function failedAskOf(ctx: Ctx, actions: readonly ActionQueueItem[], title: string, reasons: string[]): AskView {
  const appIds = uniq(actions.map(a => a.application_id))
  return {
    id: actions[0].id, kind: 'failed', title, detail: uniq(reasons).slice(0, MAX_FAIL_REASONS).join('、'),
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: actions.map(a => ({ type: 'action' as const, id: a.id })),
    action_ids: actions.map(a => a.id), due_at: earliestJobDeadline(ctx, appIds), overdue: false,
  }
}

/** 邮件失败的两件：没发出去的、没写成的（各自合成一件，「再试一次」一个动作全放回去）。 */
export function failedMailAsk(repos: Repos, ctx: Ctx): AskView[] {
  const failed = latestMailActions(repos)
  const sends = failed.filter(a => a.kind === 'send_mail')
  const drafts = failed.filter(a => a.kind === 'draft_mail')
  const out: AskView[] = []
  if (sends.length) out.push(failedAskOf(ctx, sends, `${sends.length} 封没发出去`, sends.map(mailSendFailReason)))
  if (drafts.length) out.push(failedAskOf(ctx, drafts, `${drafts.length} 封没写成`, drafts.map(a => errorOf(a) || MAIL_DRAFT_FAILED_REASON)))
  return out
}
