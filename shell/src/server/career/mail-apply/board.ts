/**
 * 邮件投递工作台（功能市场的一级功能，2026-11-06；合同 MailBoardView；GET /api/career/mail-apply/board）：
 * 一条路「可以投 → 在写 → 等你 → 已发出 → 有回音」，每份邮件申请只落在一站，按最需要他的优先：
 *   waiting（待审的 send_mail，任一用途；或等你条里那件「没写成 / 没发出去」）> writing（在写的投递 draft_mail）
 *   > replied（投出后有回音，或阶段已走过 applied）> sent（已投出、证据是邮件、没回音）> ready（库里写了投递邮箱、能开始投）。
 * 只列走邮件的；已关掉（skip / discarded）的不列。行按最近变动在前。
 * 不带任何邮件内容（明文边界不变：标题、正文、收件人全址只走 drafts / thread 接口）。
 */
import { applyChannelOf, companyMarkOf, isBouncedResend, mailPurposeOf, type ActionQueueItem, type Application, type AskView, type Job, type MailMessage, type Repos } from '@career/core';

import type { MailBoardRow, MailBoardView, MailWaitingKind } from '../../../shared/careerMailApply';
import { isDraftingMail } from '../apply-actions';
import { planJobsDetailed } from '../batch-apply';
import { asksFor } from '../delivery';
import { isBounce } from '../mail/reply-link';
import { isTargetApplication, markedTargetJobs } from '../targets';
import { heardBackSince } from './followup';
import { mailSetupView, type MailSetupDeps } from './setup';

export type MailBoardDeps = MailSetupDeps;

/** 关掉的申请不上这条路。 */
const CLOSED_STAGES: ReadonlySet<string> = new Set(['skip', 'discarded']);
/** 走过 applied 的阶段：对方已经有了回应（面试、Offer、拒信…）。 */
const BEYOND_APPLIED: ReadonlySet<string> = new Set(['responded', 'interview', 'offer', 'rejected', 'hired']);
/** 阶段走过了 applied、却没有一封来信可看时，回音的种类按阶段说。 */
const STAGE_REPLY_KIND: Record<string, string> = { responded: 'reply', interview: 'interview_invite', offer: 'offer', rejected: 'rejection', hired: 'offer' };

type Station = Pick<MailBoardRow, 'station' | 'waiting' | 'action_id' | 'ask_id' | 'sent_at' | 'reply_kind' | 'reply_at'>;
const at = (m: Pick<MailMessage, 'received_at' | 'created_at'>) => m.received_at ?? m.created_at;

/** 等他的那一封：待审的 send_mail（新的在前）。 */
function waitingOf(actions: readonly ActionQueueItem[], asks: readonly AskView[]): Station | null {
  const pending = actions.filter(a => a.kind === 'send_mail' && a.status === 'pending_review').sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
  if (pending) {
    const waiting: MailWaitingKind = isBouncedResend(pending) ? 'bounced' : mailPurposeOf(pending);
    const ask = asks.find(a => a.mail?.action_ids.includes(pending.id) || a.sources.some(s => s.id === pending.id));
    return { station: 'waiting', waiting, action_id: pending.id, ask_id: ask?.id ?? null, sent_at: null, reply_kind: null, reply_at: null };
  }
  // 没写成 / 没发出去：用等你条派生出来的那件（它已经按「每份每种用途最近一个邮件动作」算过、投出后的旧失败不再提）
  const ids = new Set(actions.map(a => a.id));
  const failed = asks.find(a => a.mail_failed && (a.action_ids ?? []).some(id => ids.has(id)));
  if (!failed?.mail_failed) return null;
  return { station: 'waiting', waiting: failed.mail_failed.stage === 'draft' ? 'failed_draft' : 'failed_send', action_id: null, ask_id: failed.id, sent_at: null, reply_kind: null, reply_at: null };
}

/** 最近一封算回音的来信（退信、自动回复 / 投递确认不算）。 */
function lastReply(repos: Repos, appId: string, sinceMs: number): MailMessage | undefined {
  return repos.listMailMessages({ application_id: appId, direction: 'in' })
    .find(m => Date.parse(at(m)) >= sinceMs && m.kind !== 'application_received' && !isBounce({ from: m.from_addr, subject: m.subject }));
}

/** 投出之后：有回音 → replied；没有 → sent；阶段还没到 applied → null。 */
function afterSend(repos: Repos, app: Application): Station | null {
  const sentMail = app.submission_evidence?.startsWith('mail:') ? repos.getMailMessage(app.submission_evidence.slice('mail:'.length)) : undefined;
  const sentAt = sentMail ? at(sentMail) : null;
  const sinceMs = sentAt ? Date.parse(sentAt) : 0;
  const base: Pick<Station, 'waiting' | 'action_id' | 'ask_id' | 'sent_at'> = { waiting: null, action_id: null, ask_id: null, sent_at: sentAt };
  if (BEYOND_APPLIED.has(app.stage) || (app.stage === 'applied' && sentMail && heardBackSince(repos, app.id, sinceMs))) {
    const reply = lastReply(repos, app.id, sinceMs);
    const kind = reply ? (reply.kind && reply.kind !== 'other' ? reply.kind : 'reply') : STAGE_REPLY_KIND[app.stage] ?? 'reply';
    return { ...base, station: 'replied', reply_kind: kind, reply_at: reply ? at(reply) : null };
  }
  if (app.stage === 'applied' && sentMail) return { ...base, station: 'sent', reply_kind: null, reply_at: null };
  return null;
}

/** 一份申请在哪一站；不在这条路上（没开始投的交给 ready 那一段算）返回 null。 */
function stationOf(repos: Repos, app: Application, actions: readonly ActionQueueItem[], asks: readonly AskView[]): Station | null {
  const waiting = waitingOf(actions, asks);
  if (waiting) return waiting;
  if (actions.some(isDraftingMail)) return { station: 'writing', waiting: null, action_id: null, ask_id: null, sent_at: null, reply_kind: null, reply_at: null };
  return afterSend(repos, app);
}

/** 这份申请走不走邮件：岗位写了投递邮箱、投递证据是邮件、或挂着邮件动作。 */
const isMailApplication = (job: Job, app: Application, actions: readonly ActionQueueItem[]): boolean =>
  applyChannelOf(job) === 'mail' || !!app.submission_evidence?.startsWith('mail:') || actions.some(a => a.kind === 'send_mail' || a.kind === 'draft_mail');

interface RowCtx { marked: ReadonlySet<string> }

function rowOf(repos: Repos, ctx: RowCtx, job: Job, app: Application | null, station: Station): MailBoardRow & { changed: string } {
  return {
    key: app?.id ?? job.id, job_id: job.id, application_id: app?.id ?? null,
    company: companyMarkOf(job.company_name, job.company_id), role: job.title, city: job.location ?? null,
    deadline: job.deadline ? job.deadline.slice(0, 10) : null,
    target: ctx.marked.has(job.id) || (!!app && isTargetApplication(repos, app.id, ctx.marked)),
    ...station, changed: app?.updated_at ?? job.updated_at,
  };
}

const READY: Station = { station: 'ready', waiting: null, action_id: null, ask_id: null, sent_at: null, reply_kind: null, reply_at: null };

/**
 * 库里写了投递邮箱、岗位还开着、能开始投的（判断复用 planJobs：已投过 / 已在投的不算）。
 * 只因为「还没有简历」被跳过的也列进来：新用户贴进来的岗位不能一刷新就不见（前端据 setup.has_resume 让他先放一份简历）。
 */
function readyJobs(deps: MailBoardDeps, placed: ReadonlySet<string>, nowMs: number): Job[] {
  const open = deps.repos.listJobs().filter(j => !placed.has(j.id) && applyChannelOf(j) === 'mail' && j.source_status !== 'closed' && j.source_status !== 'merged'
    && !(j.deadline && Date.parse(j.deadline) < nowMs));
  const plan = planJobsDetailed(deps.repos, deps.store, open.map(j => j.id));
  const ready = new Set([...plan.ready, ...plan.skipped.filter(s => s.code === 'no_resume').map(s => s.job_id)]);
  return open.filter(j => ready.has(j.id));
}

/** 工作台的全部行（见文件头）。 */
export function mailBoardRows(deps: MailBoardDeps, nowMs = Date.now()): MailBoardRow[] {
  const { repos } = deps;
  const asks = asksFor(repos);
  const ctx: RowCtx = { marked: markedTargetJobs(repos) };
  const actionsByApp = new Map<string, ActionQueueItem[]>();
  for (const a of repos.listActions()) if (a.application_id) actionsByApp.set(a.application_id, [...(actionsByApp.get(a.application_id) ?? []), a]);
  const rows: Array<MailBoardRow & { changed: string }> = [];
  const placed = new Set<string>();
  for (const app of repos.applicationsWithJob()) {
    const actions = actionsByApp.get(app.id) ?? [];
    if (CLOSED_STAGES.has(app.stage) || !isMailApplication(app.job, app, actions)) continue;
    const station = stationOf(repos, app, actions, asks);
    if (!station) continue;
    placed.add(app.job_id);
    const latest = actions.reduce((t, a) => (a.updated_at > t ? a.updated_at : t), app.updated_at);
    rows.push({ ...rowOf(repos, ctx, app.job, app, station), changed: latest });
  }
  for (const job of readyJobs(deps, placed, nowMs)) {
    const app = repos.listApplications().find(a => a.job_id === job.id) ?? null;
    rows.push(rowOf(repos, ctx, job, app, READY));
  }
  return rows.sort((x, y) => y.changed.localeCompare(x.changed)).map(({ changed: _changed, ...row }) => row);
}

/** 刚贴进来的岗位那一行（落在「可以投」；还没有简历时也照样给他看见这一行）。 */
export function readyRowOf(repos: Repos, job: Job): MailBoardRow {
  const { changed: _changed, ...row } = rowOf(repos, { marked: markedTargetJobs(repos) }, job, null, READY);
  return row;
}

export function mailBoard(deps: MailBoardDeps, nowMs = Date.now()): MailBoardView {
  return { rows: mailBoardRows(deps, nowMs), setup: mailSetupView(deps) };
}
