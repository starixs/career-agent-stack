/**
 * 一封待发邮件的最终样子（不变量 2「看到的就是发出去的」）：预览接口（view.ts）和发送（mail/send.ts）都调 resolveMail，
 * 同一份 payload、同一个解析函数——私密库占位符在本机解开成明文，算出还不能发的原因（blockers）。
 * 明文只在返回值里，不落库、不进日志。
 */
import { emailDomain, hasVaultPlaceholder, isEmailAddress, type ActionQueueItem, type MailAccount, type Repos, type Vault, type VaultAccess } from '@career/core';

import type { MailBlocker } from '../../../shared/careerMailApply';
import { isAvailabilityComplete, isInternJob, readMailProfile } from './compose';
import { parseSendMailPayload, type SendMailPayload } from './payload';

export interface MailResolveDeps { repos: Repos; vault: Vault | null }

export interface ResolvedAttachment { path: string; filename: string; sha256?: string }
export interface ResolvedMail {
  payload: SendMailPayload;
  account: MailAccount | null;
  to: string;
  cc: string | null;
  subject: string;
  body: string;
  attachments: ResolvedAttachment[];
  blockers: MailBlocker[];
}

const ACCESS: VaultAccess = { actor: 'resolve', purpose: '投递邮件预览 / 发送' };

/** 发件邮箱：payload 指定的那个；没指定（写的时候还没连邮箱）用第一个已连的。 */
export function accountOf(repos: Repos, payload: Pick<SendMailPayload, 'account_id'>): MailAccount | null {
  if (payload.account_id) return repos.getMailAccount(payload.account_id) ?? null;
  return repos.listMailAccounts()[0] ?? null;
}

/** 他自己的邮箱（不能当收件人）：所有已连邮箱 + 资料里的邮箱。小写比较。 */
export function ownAddresses(repos: Repos, vault: Vault | null): Set<string> {
  const own = new Set(repos.listMailAccounts().map(a => a.address.trim().toLowerCase()));
  const profileEmail = vault?.reveal({ scope: 'profile', field: 'email' }, ACCESS);
  if (profileEmail?.trim()) own.add(profileEmail.trim().toLowerCase());
  return own;
}

/** 收件人不对：不像一个邮箱，或者就是他自己的邮箱。 */
export function isBadRecipient(repos: Repos, vault: Vault | null, to: string): boolean {
  return !isEmailAddress(to) || ownAddresses(repos, vault).has(to.trim().toLowerCase());
}

/** 实习岗位的投递邮件才问到岗信息。 */
export function needsAvailability(repos: Repos, payload: Pick<SendMailPayload, 'purpose' | 'job_id'>): boolean {
  return payload.purpose === 'apply' && isInternJob(payload.job_id ? repos.getJob(payload.job_id) : undefined);
}

function blockersOf(deps: MailResolveDeps, mail: Omit<ResolvedMail, 'blockers'>): MailBlocker[] {
  const out: MailBlocker[] = [];
  if (!mail.account) out.push('no_mailbox');
  if (needsAvailability(deps.repos, mail.payload) && !isAvailabilityComplete(readMailProfile(deps.vault).availability)) out.push('availability');
  if (isBadRecipient(deps.repos, deps.vault, mail.to)) out.push('bad_recipient');
  const texts = [mail.subject, mail.body, ...mail.attachments.map(a => a.filename)];
  if (texts.some(t => hasVaultPlaceholder(t)) || mail.attachments.some(a => /[{}]/.test(a.filename))) out.push('unresolved');
  return out;
}

/** 解开一封待发邮件（send_mail 动作）：明文 + 还不能发的原因。payload 形状不对抛错。 */
export function resolveMail(deps: MailResolveDeps, action: Pick<ActionQueueItem, 'id' | 'payload_json'>): ResolvedMail {
  const payload = parseSendMailPayload(action.id, action.payload_json);
  const open = (s: string) => (deps.vault ? deps.vault.resolve(s, ACCESS) : s);
  const base: Omit<ResolvedMail, 'blockers'> = {
    payload,
    account: accountOf(deps.repos, payload),
    to: payload.to.trim(),
    cc: payload.cc?.trim() || null,
    subject: open(payload.subject),
    body: open(payload.body),
    attachments: (payload.attachments ?? []).map(a => ({ path: a.path, filename: open(a.filename ?? a.path.split(/[\\/]/).pop() ?? '简历.pdf'), ...(a.sha256 ? { sha256: a.sha256 } : {}) })),
  };
  return { ...base, blockers: blockersOf(deps, base) };
}

/** 日志里只记收件域名（不变量 4）。 */
export const recipientDomain = (to: string): string => emailDomain(to) || '?';
