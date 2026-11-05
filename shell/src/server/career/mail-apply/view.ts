/**
 * 一封待发邮件的完整预览（合同 shared/careerMailApply.ts 的 MailDraftView；明文只走 /api/career/mail-apply/*）。
 * 内容来自 resolveMail——和发送时同一个解析函数，看到的就是发出去的。
 */
import type { ActionQueueItem, Repos, Vault } from '@career/core';

import type { MailAttachmentView, MailDraftView } from '../../../shared/careerMailApply';
import { packetResumePlan, resumeMasterOf, tailoredChangeCount } from '../packets';
import type { CareerStore } from '../store';
import { isTargetApplication, markedTargetJobs } from '../targets';
import { readMailProfile } from './compose';
import { needsAvailability, resolveMail, type ResolvedMail } from './resolve';

export interface MailViewDeps { repos: Repos; store: CareerStore; vault: Vault | null }

/** 预览只给 pending_review 的 send_mail（等他过目的）。 */
export const isPendingDraft = (a: ActionQueueItem | undefined): a is ActionQueueItem => !!a && a.kind === 'send_mail' && a.status === 'pending_review';

function attachmentsOf(deps: MailViewDeps, mail: ResolvedMail): MailAttachmentView[] {
  const packet = mail.payload.packet_id ? deps.repos.getPacket(mail.payload.packet_id) : undefined;
  const resumeId = packet?.resume_id ?? null;
  const tailored = packet?.resume_kind === 'tailored';
  const label = resumeId ? resumeMasterOf(deps.repos, resumeId)?.name ?? '简历' : '简历';
  const changes = tailored && packet ? packetResumePlan(deps.repos, packet.id)?.changes ?? (resumeId ? tailoredChangeCount(deps.repos, resumeId) : null) : null;
  return mail.attachments.map(a => ({ filename: a.filename, resume_id: resumeId, resume_label: label, tailored_changes: tailored ? changes ?? 0 : null }));
}

/** 可换的简历：这个岗位的定制版 + 各份主简历。 */
export function resumeOptionsOf(deps: MailViewDeps, jobId: string | null): MailDraftView['resume_options'] {
  const tailored = jobId ? deps.store.listResumeTailored().filter(t => t.job_id === jobId) : [];
  return [
    ...tailored.map(t => ({ id: t.id, label: `${resumeMasterOf(deps.repos, t.id)?.name ?? '简历'}（按这个岗位改过）` })),
    ...deps.store.listResumeMasters().map(m => ({ id: m.id, label: m.name })),
  ];
}

/** 一封待发邮件 → 预览（占位符已解开、blockers 已算好）。 */
export function mailDraftView(deps: MailViewDeps, action: ActionQueueItem): MailDraftView {
  const mail = resolveMail(deps, action);
  const jobId = mail.payload.job_id ?? null;
  const job = jobId ? deps.repos.getJob(jobId) : undefined;
  const applicationId = mail.payload.application_id ?? action.application_id ?? null;
  return {
    action_id: action.id, application_id: applicationId, job_id: jobId, purpose: mail.payload.purpose ?? 'apply',
    company: job?.company_name ?? '', role: job?.title ?? '',
    target: (!!jobId && markedTargetJobs(deps.repos).has(jobId)) || isTargetApplication(deps.repos, applicationId),
    to: mail.to, cc: mail.cc, subject: mail.subject, body: mail.body,
    from: mail.account ? { account_id: mail.account.id, address: mail.account.address } : null,
    accounts: deps.repos.listMailAccounts().map(a => ({ account_id: a.id, address: a.address })),
    attachments: attachmentsOf(deps, mail),
    resume_options: resumeOptionsOf(deps, jobId),
    blockers: mail.blockers,
    availability: needsAvailability(deps.repos, mail.payload) ? readMailProfile(deps.vault).availability : null,
    ...threadOf(deps, mail),
  };
}

/** 跟进 / 回信接在哪封下面（标题上方「接着 X 那封」）；回信另带对方原信给他对照。投递邮件两项都是 null。 */
function threadOf(deps: MailViewDeps, mail: ResolvedMail): Pick<MailDraftView, 'thread' | 'incoming'> {
  const source = mail.payload.reply_to_mail_id ? deps.repos.getMailMessage(mail.payload.reply_to_mail_id) : undefined;
  if (!source) return { thread: null, incoming: null };
  const at = source.received_at ?? source.created_at;
  return {
    thread: { subject: source.subject ?? '', sent_at: at },
    incoming: source.direction === 'in' ? { from: source.from_addr ?? '', text: source.body_text ?? source.snippet ?? '', received_at: at } : null,
  };
}

/** 按 id 取几封待发邮件的预览；id 不存在或已不在待发的直接略过。 */
export function mailDraftViews(deps: MailViewDeps, ids: readonly string[]): MailDraftView[] {
  return ids.map(id => deps.repos.getAction(id)).filter(isPendingDraft).map(a => mailDraftView(deps, a));
}

/** 所有等他过目的投递邮件（存到岗信息后整张表刷新用）。 */
export function allPendingDraftViews(deps: MailViewDeps): MailDraftView[] {
  return deps.repos.listActions('pending_review').filter(isPendingDraft).map(a => mailDraftView(deps, a));
}
