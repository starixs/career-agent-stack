/**
 * 邮件投递在「等你」里的几件（face-mail-apply 2026-11-05；规范 CAREER_INTELLIGENT_UI.md §5.2）：
 *  - 写好待发的投递邮件：1 封 →「{公司} · 邮件写好了」；≥2 封合成「N 封邮件写好了」（一次过目、一键发出）。
 *  - 跟进合成一件（第三轮 R3）：1 封「{公司} · 再争取一下」、≥2 封「{N} 家可以再争取一下」，detail「投出一周没回音」。
 *  - 发出之后另外一封一件，不并进投递那件：回信「{公司} 回信了」、
 *    退信后待重发「{公司} · 邮件被退回」（mail.bounced）。kind 都是 review，AskView.mail 只带用途和动作 id（没有邮件内容）。
 *  - 发送失败：「N 封没发出去」，授权类与其余分两件（一个动作解决不了两种：重新连邮箱 / 再发一次）；
 *    再发一次 = 放回待审让他再点发出，发送永远过人。
 *  - 写邮件失败：「N 封没写成」（再试一次 = 放回队列重新写）。
 * 每份投递的每种用途只看最近一个邮件动作：已经重写 / 重发过的旧失败不再出现。
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

/** 退信后照抄的那封（payload.bounced_from = 被退回的收件地址）。 */
export const isBouncedResend = (a: Pick<ActionQueueItem, 'payload_json'>): boolean => !!strOf(parseObj(a.payload_json).bounced_from)

function mailAsk(ctx: Ctx, actions: readonly ActionQueueItem[], purpose: AskMailPurpose, title: string, bounced = false): AskView {
  const appIds = uniq(actions.map(a => a.application_id))
  const ids = actions.map(a => a.id)
  return {
    id: ids[0], kind: 'review', title,
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: ids.map(id => ({ type: 'action' as const, id })),
    due_at: earliestJobDeadline(ctx, appIds), overdue: false, mail: { purpose, action_ids: ids, ...(bounced ? { bounced: true } : {}) },
  }
}

const companyOfAction = (ctx: Ctx, a: ActionQueueItem): string | undefined => (a.application_id ? ctx.apps.get(a.application_id)?.company.name : undefined)

/** 一封一件的标题：投递「甲 · 邮件写好了」、回信「甲 回信了」、跟进「甲 · 再争取一下」、退信「甲 · 邮件被退回」。 */
function oneTitle(ctx: Ctx, a: ActionQueueItem, purpose: AskMailPurpose): string {
  const company = companyOfAction(ctx, a)
  const who = company ? shortName(company) : ''
  if (isBouncedResend(a)) return who ? `${who} · 邮件被退回` : '邮件被退回'
  if (purpose === 'reply') return who ? `${who} 回信了` : '对方回信了'
  if (purpose === 'followup') return who ? `${who} · 再争取一下` : '再争取一下'
  return who ? `${who} · 邮件写好了` : '邮件写好了'
}

/** 跟进那件写的事实（不是规则说明）。 */
export const FOLLOWUP_DETAIL = '投出一周没回音'

/**
 * 待审的 send_mail → 等你里的几件：投递邮件合成一件；跟进也合成一件（几十份一周后会同时到期，一家一件会刷屏）；
 * 退信重发、回信一封一件。
 */
export function mailReviewAsks(ctx: Ctx, pending: readonly ActionQueueItem[]): AskView[] {
  const mails = pending.filter(isMailReviewKind)
  const apply = mails.filter(a => mailPurposeOf(a) === 'apply' && !isBouncedResend(a))
  const follow = mails.filter(a => mailPurposeOf(a) === 'followup')
  const out: AskView[] = []
  if (apply.length === 1) out.push(mailAsk(ctx, apply, 'apply', oneTitle(ctx, apply[0], 'apply')))
  if (apply.length > 1) out.push(mailAsk(ctx, apply, 'apply', `${apply.length} 封邮件写好了`))
  if (follow.length) out.push({ ...mailAsk(ctx, follow, 'followup', follow.length === 1 ? oneTitle(ctx, follow[0], 'followup') : `${follow.length} 家可以再争取一下`), detail: FOLLOWUP_DETAIL })
  for (const a of mails.filter(m => !apply.includes(m) && !follow.includes(m))) {
    const purpose = mailPurposeOf(a)
    out.push(mailAsk(ctx, [a], purpose, oneTitle(ctx, a, purpose), isBouncedResend(a)))
  }
  return out
}

// ---------- 没发出去 / 没写成 ----------

/** 投递邮件：投递已经走完（投出、关掉）的不再提它的失败。 */
const SETTLED_STAGES: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'discarded', 'skip'])
/** 跟进 / 回信：发生在投出之后，只有申请关掉了才不再提。 */
const CLOSED_STAGES: ReadonlySet<string> = new Set(['hired', 'rejected', 'discarded', 'skip'])
/** 邮箱授权的错：授权码失效 / 被改，要重新连邮箱，再发一次没用。 */
const AUTH_ERROR_RX = /授权|auth|535|credential|login|密码/i
export const MAIL_AUTH_FAILED_REASON = '邮箱授权失效了，重新连一下邮箱'
export const MAIL_SEND_FAILED_REASON = '发送没成功'
/** 发到一半进程没了（启动清扫置 failed）：不知道发没发出去，原样告诉他，由他决定要不要再发。 */
export const MAIL_SEND_INTERRUPTED_REASON = '发到一半中断了，不确定有没有发出去'
export const MAIL_DRAFT_FAILED_REASON = '没写成'
/** 理由最多并列几种（和「N 家没填成」同一个取舍）。 */
const MAX_FAIL_REASONS = 2

const errorOf = (a: ActionQueueItem): string => strOf(parseObj(a.result_json).error) ?? ''

/** 发送失败给人看的一句：授权问题单独说（指向重新连邮箱），其余一律「发送没成功」。 */
export function mailSendFailReason(a: ActionQueueItem): string {
  return isAuthFailure(a) ? MAIL_AUTH_FAILED_REASON : MAIL_SEND_FAILED_REASON
}
const isAuthFailure = (a: ActionQueueItem): boolean => AUTH_ERROR_RX.test(errorOf(a))

/** 失败还值得提：投递邮件在投出前；跟进 / 回信在申请关掉前。 */
function stillOpen(repos: Repos, a: ActionQueueItem): boolean {
  if (!a.application_id) return true
  const stage = repos.getApplication(a.application_id)?.stage ?? ''
  return !(mailPurposeOf(a) === 'apply' && !isBouncedResend(a) ? SETTLED_STAGES : CLOSED_STAGES).has(stage)
}

/** 每份投递每种用途（没有投递的按动作）最近一个邮件动作。 */
function latestMailActions(repos: Repos): ActionQueueItem[] {
  const latest = new Map<string, ActionQueueItem>()
  for (const a of repos.listActions()) {
    if (a.kind !== 'send_mail' && a.kind !== 'draft_mail') continue
    const key = a.application_id ? `${a.application_id}:${mailPurposeOf(a)}` : a.id
    const prev = latest.get(key)
    if (!prev || prev.created_at < a.created_at || (prev.created_at === a.created_at && prev.updated_at < a.updated_at)) latest.set(key, a)
  }
  return [...latest.values()].filter(a => a.status === 'failed' && stillOpen(repos, a))
    .sort((x, y) => x.created_at.localeCompare(y.created_at))
}

function failedAskOf(ctx: Ctx, actions: readonly ActionQueueItem[], title: string, reasons: string[], stage: 'draft' | 'send', reauth: boolean): AskView {
  const appIds = uniq(actions.map(a => a.application_id))
  return {
    id: actions[0].id, kind: 'failed', title, detail: uniq(reasons).slice(0, MAX_FAIL_REASONS).join('、'),
    application_ids: appIds, companies: companiesOf(ctx, appIds), sources: actions.map(a => ({ type: 'action' as const, id: a.id })),
    action_ids: actions.map(a => a.id), due_at: earliestJobDeadline(ctx, appIds), overdue: false, mail_failed: { stage, reauth },
  }
}

/**
 * 邮件失败：没写成的一件；没发出去的按原因分两件——邮箱授权失效（重新连邮箱）和其余（再发一次）。
 * 各自合成一件，一个动作全放回去。
 */
export function failedMailAsk(repos: Repos, ctx: Ctx): AskView[] {
  const failed = latestMailActions(repos)
  const sends = failed.filter(a => a.kind === 'send_mail')
  const auth = sends.filter(isAuthFailure)
  const other = sends.filter(a => !isAuthFailure(a))
  const drafts = failed.filter(a => a.kind === 'draft_mail')
  const out: AskView[] = []
  if (auth.length) out.push(failedAskOf(ctx, auth, `${auth.length} 封没发出去`, [MAIL_AUTH_FAILED_REASON], 'send', true))
  if (other.length) out.push(failedAskOf(ctx, other, `${other.length} 封没发出去`, other.map(a => (errorOf(a) === MAIL_SEND_INTERRUPTED_REASON ? MAIL_SEND_INTERRUPTED_REASON : MAIL_SEND_FAILED_REASON)), 'send', false))
  if (drafts.length) out.push(failedAskOf(ctx, drafts, `${drafts.length} 封没写成`, drafts.map(a => errorOf(a) || MAIL_DRAFT_FAILED_REASON), 'draft', false))
  return out
}
