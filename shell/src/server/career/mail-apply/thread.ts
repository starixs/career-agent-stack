/**
 * 一份申请的邮件往来（合同 MailThreadView；GET /api/career/mail-apply/thread?application_id=）：
 * 发出的投递邮件 / 跟进 / 回信、对方来的信、写好等他点发出的那封，按时间从早到晚。给申请对象卡和进展页看。
 * 明文边界同预览：整封内容只走这个接口，不进日志。待发的那封走 resolveMail（和预览、发送同一个解析函数）。
 */
import { mailPurposeOf, type MailMessage } from '@career/core';

import type { MailThreadItem, MailThreadView } from '../../../shared/careerMailApply';
import { bareAddress, isBounce } from '../mail/reply-link';
import { parseSendMailPayload } from './payload';
import { resolveMail } from './resolve';
import { isPendingDraft, type MailViewDeps } from './view';

/** 一封信最多列多少：一份申请的往来不会超过这个数。 */
const THREAD_MAIL_LIMIT = 200;

const open = (deps: MailViewDeps, text: string): string => (deps.vault ? deps.vault.resolve(text, { actor: 'resolve', purpose: '邮件往来' }) : text);

/** 发出那封的附件名（从发它的动作里读，占位符在本机解开）。 */
function sentAttachments(deps: MailViewDeps, m: MailMessage): string[] {
  const action = m.action_id ? deps.repos.getAction(m.action_id) : undefined;
  if (!action) return [];
  const p = parseSendMailPayload(action.id, action.payload_json);
  return (p.attachments ?? []).map(a => open(deps, a.filename ?? a.path.split(/[\\/]/).pop() ?? ''));
}

/** 来信的种类：退信通知统一叫 bounced（前端显示「被退回」；只在视图层，不改落库的 kind）。 */
const inKind = (m: MailMessage): string | null => (isBounce({ from: m.from_addr, subject: m.subject }) ? 'bounced' : m.kind);

function mailItem(deps: MailViewDeps, m: MailMessage): MailThreadItem {
  const out = m.direction === 'out';
  const action = out && m.action_id ? deps.repos.getAction(m.action_id) : undefined;
  return {
    id: m.id, direction: m.direction, purpose: out ? (action ? mailPurposeOf(action) : 'apply') : null,
    counterpart: out ? (m.to_addr ?? '') : (bareAddress(m.from_addr) ?? m.from_addr ?? ''),
    subject: m.subject ?? '', body: m.body_text ?? m.snippet ?? '',
    attachments: out ? sentAttachments(deps, m) : [], at: m.received_at ?? m.created_at, action_id: null, kind: out ? null : inKind(m),
  };
}

/** 写好等他点发出的那几封。 */
function pendingItems(deps: MailViewDeps, applicationId: string): MailThreadItem[] {
  return deps.repos.listActions('pending_review').filter(isPendingDraft).filter(a => a.application_id === applicationId).map(a => {
    const mail = resolveMail(deps, a);
    return {
      id: a.id, direction: 'pending' as const, purpose: mail.payload.purpose ?? 'apply', counterpart: mail.to, subject: mail.subject, body: mail.body,
      attachments: mail.attachments.map(x => x.filename), at: a.updated_at, action_id: a.id, kind: null,
    };
  });
}

/** 一份申请的邮件往来；申请不存在返回 null。 */
export function mailThreadView(deps: MailViewDeps, applicationId: string): MailThreadView | null {
  const app = deps.repos.getApplication(applicationId);
  if (!app) return null;
  const job = deps.repos.getJob(app.job_id);
  const mails = deps.repos.listMailMessages({ application_id: applicationId, limit: THREAD_MAIL_LIMIT }).filter(m => m.relevance !== 'ignored');
  const items = [...mails.map(m => mailItem(deps, m)), ...pendingItems(deps, applicationId)]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { application_id: applicationId, company: job?.company_name ?? '', role: job?.title ?? '', items };
}
