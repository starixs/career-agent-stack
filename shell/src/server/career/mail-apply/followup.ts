/**
 * 没回音满一周 → 跟进写好放进等你条（face-mail-apply 阶段二 P2.6）。
 *  - dueFollowups：纯查询，该跟进的申请（条件见函数注释）。每份申请一生只跟一次：任何状态的 followup 动作都算跟过，
 *    包括他点了「不跟了」的、被系统作废的。
 *  - runFollowupSweep：对每个到期申请排一个 draft_mail（purpose followup，系统批准），叫醒起草器；写好进等你，他点发出才发。
 *  - cancelPendingFollowUps：对方来了新回音，还在待审 / 还没写的跟进和回信作废（rejected，系统作的），不让他去催刚回过信的人。
 * 日志只记申请与动作 id。
 */
import { isBouncedResend, mailPurposeOf, type ActionQueueItem, type Job, type MailMessage, type Repos } from '@career/core';

import { isBounce } from '../mail/reply-link';
import { kickMailDrafter } from './runner';

/** 投出后多久没回音就跟进一封：世界模型「回音多半在投出后 7 天内」，满一周还没动静值得问一句。 */
export const FOLLOWUP_AFTER_DAYS = 7;
/** 跟进最多每小时扫一次：到期按天算，扫得再勤也不会早一封。 */
export const FOLLOWUP_SWEEP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const isFollowKind = (a: ActionQueueItem) => a.kind === 'draft_mail' || a.kind === 'send_mail';
const timeOf = (m: Pick<MailMessage, 'received_at' | 'created_at'>): number => Date.parse(m.received_at ?? m.created_at);

/** 发出之后来过的回音：挂在申请上的来信，自动回复 / 投递确认和退信都不算。 */
export function heardBackSince(repos: Repos, applicationId: string, sinceMs: number): boolean {
  return repos.listMailMessages({ application_id: applicationId, direction: 'in' })
    .some(m => timeOf(m) >= sinceMs && m.kind !== 'application_received' && !isBounce({ from: m.from_addr, subject: m.subject }));
}

/** 这份申请跟进过没有（任何状态的 followup 动作都算）。 */
export function hasFollowedUp(repos: Repos, applicationId: string): boolean {
  return repos.listActions().some(a => a.application_id === applicationId && isFollowKind(a) && mailPurposeOf(a) === 'followup');
}

/** 岗位还开着：没过截止、没关闭。 */
function jobOpen(job: Job, nowMs: number): boolean {
  if (job.source_status === 'closed') return false;
  const deadline = job.deadline ? Date.parse(job.deadline) : NaN;
  return Number.isNaN(deadline) || deadline > nowMs;
}

export interface DueFollowup { application_id: string; job_id: string; sent: MailMessage }

/**
 * 该跟进的申请：阶段正是 applied；投递证据是邮件（mail:）；那封发出已满 FOLLOWUP_AFTER_DAYS 天；发出之后没收到过回音；
 * 从没跟进过；岗位没过截止、没关闭。
 */
export function dueFollowups(repos: Repos, nowIso: string): DueFollowup[] {
  const nowMs = Date.parse(nowIso);
  const out: DueFollowup[] = [];
  for (const app of repos.applicationsWithJob()) {
    if (app.stage !== 'applied' || !app.submission_evidence?.startsWith('mail:')) continue;
    const sent = repos.getMailMessage(app.submission_evidence.slice('mail:'.length));
    if (!sent || sent.direction !== 'out') continue;
    const sentMs = timeOf(sent);
    if (nowMs - sentMs < FOLLOWUP_AFTER_DAYS * DAY_MS) continue;
    if (heardBackSince(repos, app.id, sentMs) || hasFollowedUp(repos, app.id) || !jobOpen(app.job, nowMs)) continue;
    out.push({ application_id: app.id, job_id: app.job_id, sent });
  }
  return out;
}

/** 对每个到期申请排一封跟进（系统批准，后台写，写好等他过目）。返回排出的 draft_mail id。 */
export function runFollowupSweep(repos: Repos, nowIso: string): string[] {
  const ids = dueFollowups(repos, nowIso).map(d =>
    repos.enqueueAction('draft_mail', { purpose: 'followup', job_id: d.job_id, application_id: d.application_id, reply_to_mail_id: d.sent.id }, d.application_id, true).id);
  if (ids.length) {
    kickMailDrafter();
    console.log(`[career] mail-followup queued n=${ids.length} actions=${ids.join(',')}`);
  }
  return ids;
}

let lastSweepMs = 0;
/** Global 邮件轮询之后调：最多每 FOLLOWUP_SWEEP_INTERVAL_MS 扫一次。 */
export function maybeRunFollowupSweep(repos: Repos, nowMs = Date.now()): string[] {
  if (nowMs - lastSweepMs < FOLLOWUP_SWEEP_INTERVAL_MS) return [];
  lastSweepMs = nowMs;
  return runFollowupSweep(repos, new Date(nowMs).toISOString());
}

/** 还没写完 / 写好等他点的跟进与回信（退信后的重发不算：那是投递本身）。 */
const isPendingFollow = (a: ActionQueueItem): boolean =>
  isFollowKind(a) && mailPurposeOf(a) !== 'apply' && !isBouncedResend(a)
  && ((a.kind === 'send_mail' && a.status === 'pending_review') || (a.kind === 'draft_mail' && (a.status === 'approved' || a.status === 'pending_review')));

/** 对方来了新回音：这份申请还挂着的跟进与回信作废（系统作的）。返回作废的动作 id。 */
export function cancelPendingFollowUps(repos: Repos, applicationId: string, reason: string): string[] {
  const ids = repos.listActions().filter(a => a.application_id === applicationId && isPendingFollow(a)).map(a => a.id);
  for (const id of ids) repos.setActionStatus(id, 'rejected', { reason, by: 'system' });
  if (ids.length) console.log(`[career] mail-followup cancelled app=${applicationId} actions=${ids.join(',')}`);
  return ids;
}
