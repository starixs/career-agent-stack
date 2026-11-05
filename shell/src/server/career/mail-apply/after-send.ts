/**
 * 投递邮件发出之后，来信落库时做的几件事（face-mail-apply 阶段二；sync.ts archiveMail 调）：
 *  - 退信（P2.3）：认出退的是哪封 → 申请从 applied 撤回（undoLastStage：漏斗和「我的求职月」不多算一份）、卷宗一笔、
 *    照抄那封排一封待审的重发（bounced_from = 原收件人；收件人不改就是 bad_recipient）。不调模型、不进收件归档。
 *    同一封退信来两次不重复排。
 *  - 认回的回音（P2.2 的 ① ②，非自动回复）：还挂着的跟进 / 回信作废（P2.6 撤回）；对方在等回话、又不是面试 / 笔试 /
 *    测评 / Offer / 拒信（那些各有等你卡）→ 排一封回信草稿（P2.5）。
 * 发信永远过人：这里只排 draft_mail（系统批准，后台写）和待审的 send_mail，从不发。
 */
import type { ActionQueueItem, MailAccount, MailMessage, Repos } from '@career/core';

import { dataChanged, type IntakeDeps, type TriageResult } from '../intake';
import { isBounce, isNotificationMail, locateBounced } from '../mail/reply-link';
import type { FetchedMail } from '../mail/sync';
import { cancelPendingFollowUps } from './followup';
import { parseSendMailPayload } from './payload';
import { kickMailDrafter } from './runner';

/** 这几类来信各有自己的等你卡，不再另起一封回信。 */
const OWN_ASK_KINDS: ReadonlySet<string> = new Set(['interview_invite', 'written_test', 'assessment', 'offer', 'rejection']);
export const BOUNCE_NOTE = '投递邮件被退回：收件地址不存在或拒收';

/** 这封被退回的信已经排过重发了（任何状态都算：同一封退信来两次不重复排）。 */
function resendOf(repos: Repos, bouncedMailId: string): ActionQueueItem | undefined {
  return repos.db.get<ActionQueueItem>(`SELECT * FROM action_queue WHERE kind='send_mail' AND json_extract(payload_json, '$.bounced_mail_id')=? LIMIT 1`, [bouncedMailId]);
}

/** 照抄被退的那封排一封待审的重发；原动作读不出来返回 null（不猜内容）。 */
function enqueueResend(repos: Repos, sent: MailMessage & { application_id: string }): ActionQueueItem | null {
  const original = sent.action_id ? repos.getAction(sent.action_id) : undefined;
  if (!original) return null;
  const { draft_action_id: _drafted, ...payload } = parseSendMailPayload(original.id, original.payload_json);
  return repos.enqueueAction('send_mail', { ...payload, bounced_from: sent.to_addr ?? payload.to, bounced_mail_id: sent.id }, sent.application_id);
}

/** 退的是这份投递的那封投递邮件、申请还停在 applied：撤回这次投出。已有回音（走得更远）的不撤。 */
function undoApplied(repos: Repos, appId: string, sentId: string): boolean {
  const app = repos.getApplication(appId);
  if (!app || app.stage !== 'applied' || app.submission_evidence !== `mail:${sentId}`) return false;
  repos.undoLastStage(appId, '邮件被退回');
  return true;
}

/**
 * 退信：认出来就处理完返回 true（调用方不再走归档）；不是退信、或认不出退的是哪封返回 false（当普通邮件走原路径）。
 */
export function handleBounceMail(deps: IntakeDeps, account: MailAccount, m: FetchedMail): boolean {
  const r = deps.repos;
  if (!isBounce(m)) return false;
  const sent = locateBounced(r, m, deps.now?.() ?? new Date().toISOString());
  if (!sent) return false;
  const row = r.insertMailMessage({
    account_id: account.id, uid: m.uid, message_id: m.message_id, in_reply_to: m.in_reply_to, direction: 'in',
    from_addr: m.from, to_addr: m.to, subject: m.subject, snippet: m.text.slice(0, 200), body_text: m.text.slice(0, 20_000), received_at: m.received_at,
    relevance: 'job', kind: null, inbox_item_id: null, application_id: sent.application_id, action_id: null,
  });
  if (!row || resendOf(r, sent.id)) return true;
  const undone = undoApplied(r, sent.application_id, sent.id);
  r.addDossierNote({ application_id: sent.application_id, kind: 'mail', content: BOUNCE_NOTE });
  const resend = enqueueResend(r, sent);
  dataChanged(deps, ['mail_message', 'dossier_note', 'action_queue', ...(undone ? ['application', 'application_history'] : [])]);
  console.log(`[career] mail-bounce app=${sent.application_id} sent=${sent.id} undone=${undone} resend=${resend?.id ?? '-'}`);
  return true;
}

/** 这封来信已经有回信草稿了（任何状态的 reply 动作挂着它）。 */
function hasReplyDraft(repos: Repos, mailId: string): boolean {
  return !!repos.db.get(`SELECT 1 FROM action_queue WHERE kind IN ('draft_mail','send_mail') AND json_extract(payload_json, '$.purpose')='reply' AND json_extract(payload_json, '$.reply_to_mail_id')=? LIMIT 1`, [mailId]);
}

/** 排一封回信草稿（系统批准，后台写）。返回动作，或给人看的不能排的原因。他自己要回（mail_reply 工具）时 notes 是他的话。 */
export function enqueueReplyDraft(repos: Repos, input: { application_id: string; mail: MailMessage; notes?: string | null; force?: boolean }): ActionQueueItem | string {
  const app = repos.getApplication(input.application_id);
  if (!app) return `投递不存在：${input.application_id}`;
  if (input.mail.direction !== 'in') return '这封不是对方来的信';
  if (!input.force && hasReplyDraft(repos, input.mail.id)) return '这封已经在写回信了';
  const notes = input.notes?.trim();
  const action = repos.enqueueAction('draft_mail', { purpose: 'reply', job_id: app.job_id, application_id: app.id, reply_to_mail_id: input.mail.id, ...(notes ? { notes } : {}) }, app.id, true);
  kickMailDrafter();
  console.log(`[career] mail-reply queued app=${app.id} action=${action.id} mail=${input.mail.id}`);
  return action;
}

/**
 * 认回的回音（非自动回复）落库后：撤回挂着的跟进 / 回信；对方（一个人）在等回话就排一封回信。
 * 通知型来信（noreply、招聘系统代发、「请勿回复」）规则先挡：哪怕模型判了要回也不起草（第三轮 R4）。
 */
export function afterLinkedReply(deps: IntakeDeps, applicationId: string, row: MailMessage, triage: TriageResult | null): void {
  const cancelled = cancelPendingFollowUps(deps.repos, applicationId, '对方回信了');
  const notification = isNotificationMail({ from: row.from_addr, text: row.body_text });
  const wantsReply = !notification && triage?.needs_reply === true && !OWN_ASK_KINDS.has(String(triage.kind ?? ''));
  const queued = wantsReply ? enqueueReplyDraft(deps.repos, { application_id: applicationId, mail: row }) : null;
  if (cancelled.length || (queued && typeof queued !== 'string')) dataChanged(deps, ['action_queue']);
}
