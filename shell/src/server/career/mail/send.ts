/**
 * 发送投递邮件：只能从待审队列里已批准的 send_mail 动作执行（提交与发送永远过人）。
 * 发之前和预览接口走同一个解析函数（mail-apply/resolve.ts）拿最终的收件人 / 标题 / 正文 / 附件名：
 * 还有解不开的私密资料、没连邮箱、收件人不对、到岗信息没填 → 不发，放回待审并报错（不是失败，是还差东西）。
 * 发送成功 → mail_message(out) + 卷宗笔记 + 素材使用记录 + 投递推进到 applied。
 */
import { existsSync } from 'fs';
import { basename } from 'path';
import { emailDomain, type ActionQueueItem, type MailAccount, type Repos, type Vault } from '@career/core';

import { dataChanged, focus, type IntakeDeps } from '../intake';
import { MAIL_TOTAL_MAX_BYTES, MAIL_TRUST_KEY, MAIL_TRUST_LABEL } from '../../../shared/careerMailApply';
import { recordSuccess } from '../trust-ledger';
import { totalSize } from '../mail-apply/attachments-edit';
import { resolveMail, type ResolvedMail } from '../mail-apply/resolve';
import { fileSha256 } from '../packets';
import { serverConfig } from '../server-api';
import { getMailPassword } from './credentials';
import { remoteSend } from './remote';
import { smtpSecure } from './providers';
import type { SendMailPayload } from '../mail-apply/payload';

export type { SendMailPayload } from '../mail-apply/payload';

export interface MailSendDeps extends IntakeDeps {
  /** 测试注入：替代 nodemailer。 */
  transport?: (account: MailAccount, password: string, mail: SendMailPayload) => Promise<{ messageId: string | null }>;
  /** 私密库：解开占位符、认出他自己的邮箱。缺省按 repos 的连接构造；null = 不解（只用于没有占位符的老邮件）。 */
  vault?: Vault | null;
}

/** 还不能发的原因给调用方的一句（不含邮件内容）。 */
const BLOCKER_TEXT: Record<string, string> = { no_mailbox: '还没连邮箱', availability: '实习到岗信息还没填', bad_recipient: '收件人不对', unresolved: '还有资料没填（如手机号）' };

async function sendViaSmtp(account: MailAccount, password: string, mail: SendMailPayload): Promise<{ messageId: string | null }> {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({ host: account.smtp_host, port: account.smtp_port, secure: smtpSecure(account.smtp_port), auth: { user: account.address, pass: password } });
  const info = await transporter.sendMail({
    from: account.display_name ? `"${account.display_name}" <${account.address}>` : account.address,
    to: mail.to, cc: mail.cc || undefined, subject: mail.subject, text: mail.body,
    // 跟进 / 回信接在原信下面：对方的邮箱按这两个头把它归进同一个会话
    ...(mail.in_reply_to ? { inReplyTo: mail.in_reply_to } : {}),
    ...(mail.references?.length ? { references: mail.references } : {}),
    attachments: (mail.attachments ?? []).map(a => ({ path: a.path, filename: a.filename ?? basename(a.path) })),
  });
  return { messageId: info.messageId ?? null };
}

async function vaultOf(deps: MailSendDeps): Promise<Vault | null> {
  if (deps.vault !== undefined) return deps.vault;
  const { vaultForRepos } = await import('../vault');
  return vaultForRepos(deps.repos);
}

/** 解开这封；还差东西就放回待审、报错，不发。 */
async function resolveOrReopen(deps: MailSendDeps, action: ActionQueueItem): Promise<ResolvedMail & { account: MailAccount }> {
  const mail = resolveMail({ repos: deps.repos, vault: await vaultOf(deps) }, action);
  if (!mail.blockers.length && mail.account) return { ...mail, account: mail.account };
  deps.repos.reopenAction(action.id);
  dataChanged(deps, ['action_queue']);
  console.warn(`[career] mail-send BLOCKED action=${action.id} blockers=${mail.blockers.join(',')}`);
  throw new Error(`这封邮件还不能发（${mail.blockers.map(b => BLOCKER_TEXT[b] ?? b).join('、')}），已放回待发`);
}

/** 附件加起来超过上限（对方邮箱收不下、会被退回）：不发，放回待审让他拿掉一个或换成链接。 */
function checkTotalSize(deps: MailSendDeps, action: ActionQueueItem, mail: ResolvedMail): void {
  const total = totalSize(mail.payload);
  if (total <= MAIL_TOTAL_MAX_BYTES) return;
  deps.repos.reopenAction(action.id, { error: '附件加起来超过 20MB' });
  dataChanged(deps, ['action_queue']);
  console.warn(`[career] mail-send BLOCKED action=${action.id} reason=too_large bytes=${total}`);
  throw new Error('附件加起来超过 20MB，对方邮箱多半收不下，已放回待发：拿掉一个或换成链接');
}

/** 每个附件都必须是批准时冻结的那一份；对不上记失败。 */
function checkAttachments(deps: MailSendDeps, actionId: string, mail: ResolvedMail): void {
  for (const a of mail.attachments) {
    const changedFile = !existsSync(a.path) ? '附件文件不见了' : a.sha256 && fileSha256(a.path) !== a.sha256 ? '附件内容与批准时不一致' : '';
    if (!changedFile) continue;
    deps.repos.setActionStatus(actionId, 'failed', { error: `${changedFile}：${a.filename}` });
    dataChanged(deps, ['action_queue']);
    throw new Error(`${changedFile}，没有发送：${a.filename}`);
  }
}

/** 认领（同一封只会被发一次；批准之后内容变了会退回待审）。 */
function claimOrThrow(deps: MailSendDeps, actionId: string): void {
  const claim = deps.repos.claimAction(actionId);
  if (claim.ok) return;
  dataChanged(deps, ['action_queue']);
  throw new Error(claim.reason === 'content_changed' ? '这封邮件在批准后内容有变化，已退回待审核，请重新确认' : `这封邮件已不是待发送状态（${claim.action?.status ?? '不存在'}），不会重复发送`);
}

type Credentials = { cloud: ReturnType<typeof serverConfig>; password: string };

/** 授权码缺失的那句：要能被等你条认成授权问题（core asks-mail AUTH_ERROR_RX），出「邮箱授权失效了」。 */
export const MISSING_PASSWORD_ERROR = '邮箱授权码没有保存，需要重新授权';

/**
 * 云端连接：授权码在云端，经云端代发、云端留痕；本机连接：本机 SMTP 发、本机留痕。认领前查。
 * 缺授权码 → 动作置 failed（等你里「N 封没发出去 · 邮箱授权失效了」），不留在 approved 里没人看得见。
 */
function credentialsOf(deps: MailSendDeps, actionId: string, account: MailAccount): Credentials {
  const cloud = account.remote_id ? serverConfig(deps.repos) : null;
  const password = cloud ? '' : getMailPassword(account.id);
  if (!cloud && !password) {
    deps.repos.setActionStatus(actionId, 'failed', { error: MISSING_PASSWORD_ERROR });
    dataChanged(deps, ['action_queue']);
    console.warn(`[career] mail-send FAILED action=${actionId} reason=no_password account=${account.id}`);
    throw new Error(MISSING_PASSWORD_ERROR);
  }
  return { cloud, password: password ?? '' };
}

/**
 * 发送最后一道关（不变量 3 不重复发）：这份投递已经发出过投递邮件（证据 mail:、阶段已投出及之后），
 * 再来一封投递邮件不发，动作置 rejected——这不是失败，不进「没发出去」。退信后的重发（bounced_from）不受此限。
 */
function alreadySentApply(deps: MailSendDeps, action: ActionQueueItem, payload: SendMailPayload): boolean {
  if ((payload.purpose ?? 'apply') !== 'apply' || payload.bounced_from) return false;
  const appId = payload.application_id ?? action.application_id;
  const app = appId ? deps.repos.getApplication(appId) : undefined;
  if (!app || !app.submission_evidence?.startsWith('mail:') || !SENT_STAGES.has(app.stage)) return false;
  deps.repos.setActionStatus(action.id, 'rejected', { reason: '这份已经发过投递邮件' });
  dataChanged(deps, ['action_queue']);
  console.log(`[career] mail-send skipped action=${action.id} app=${app.id} reason=already_sent`);
  return true;
}

/** 交给 SMTP / 云端代发；失败记 failed（等你里出「N 封没发出去」）。本机连接留痕。 */
async function transmit(deps: MailSendDeps, action: ActionQueueItem, account: MailAccount, mail: ResolvedMail, creds: Credentials): Promise<string | null> {
  const r: Repos = deps.repos;
  const { cloud, password } = creds;
  const out: SendMailPayload = { ...mail.payload, to: mail.to, ...(mail.cc ? { cc: mail.cc } : {}), subject: mail.subject, body: mail.body, attachments: mail.attachments };
  // 助理代发必须留痕：连接管理页能看到「它替我发了什么」
  const audit = { to: mail.to.split(/[,;\s]+/).filter(Boolean), subject_preview: mail.subject.slice(0, 20), trigger: action.id };
  const started = Date.now();
  const remoteId = account.remote_id;
  const transport = deps.transport ?? (cloud && remoteId ? (_a: MailAccount, _p: string, m: SendMailPayload) => remoteSend(cloud, remoteId, m, action.id) : sendViaSmtp);
  try {
    const { messageId } = await transport(account, password, out);
    if (!cloud) r.addMailAudit({ account_id: account.id, actor: 'agent', operation: 'send', status: 'ok', detail: audit, latency_ms: Date.now() - started });
    return messageId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!cloud) r.addMailAudit({ account_id: account.id, actor: 'agent', operation: 'send', status: 'failed', detail: { ...audit, error: msg.slice(0, 200) }, latency_ms: Date.now() - started });
    r.setActionStatus(action.id, 'failed', { error: msg });
    dataChanged(deps, ['action_queue']);
    console.warn(`[career] mail-send FAILED action=${action.id} domain=${emailDomain(mail.to)}`);
    throw new Error(`发送失败：${msg}`);
  }
}

/** 投出及之后的阶段（发出投递邮件不再往回推；这份已经投过）。 */
const SENT_STAGES: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired']);
/** 卷宗里那一笔（不写标题与全址）。 */
const SENT_NOTE: Record<NonNullable<SendMailPayload['purpose']>, string> = { apply: '已发出投递邮件', followup: '已发出跟进邮件', reply: '已回信' };

/** 投递邮件发出：推进到 applied（证据 mail:）；退信后重发成功的，把新地址记回岗位。跟进 / 回信不动阶段。 */
function advanceOnApply(r: Repos, appId: string, mail: ResolvedMail, mailId: string, tables: string[]): void {
  if ((mail.payload.purpose ?? 'apply') !== 'apply') return;
  const app = r.getApplication(appId);
  if (app && !SENT_STAGES.has(app.stage)) {
    r.jumpTo(appId, 'applied', mail.payload.bounced_from ? '退信后重发的投递邮件已发送' : '邮件投递已发送', { submission_evidence: `mail:${mailId}` });
    tables.push('application', 'application_history');
  }
  // 信任账本：「邮件投递」这一类又做通了一封；做通两封后右栏 / 勾选表提议「以后直接发？」（他点了才放）
  recordSuccess(r, { key: MAIL_TRUST_KEY, label: MAIL_TRUST_LABEL, kind: 'system' });
  tables.push('kv');
  if (mail.payload.bounced_from && mail.payload.job_id) {
    r.db.update('job', mail.payload.job_id, { apply_email: mail.to, updated_at: new Date().toISOString() });
    tables.push('job');
  }
}

/** 发出之后：邮件记录（带线程头）、卷宗一笔、素材使用（存占位符版，不存明文）、投递邮件推进到 applied。 */
function recordSent(deps: MailSendDeps, action: ActionQueueItem, account: MailAccount, mail: ResolvedMail, messageId: string | null): { mail_id: string; application_id: string | null } {
  const r = deps.repos;
  const appId = mail.payload.application_id ?? action.application_id ?? null;
  const purpose = mail.payload.purpose ?? 'apply';
  const row = r.insertMailMessage({
    account_id: account.id, uid: null, message_id: messageId, in_reply_to: mail.payload.in_reply_to ?? null, direction: 'out',
    from_addr: account.address, to_addr: mail.to, subject: mail.subject, snippet: mail.body.slice(0, 200), body_text: mail.body,
    received_at: new Date().toISOString(), relevance: 'job', kind: null, inbox_item_id: null, application_id: appId, action_id: action.id,
  })!;
  const tables = ['action_queue', 'mail_message'];
  if (appId && r.getApplication(appId)) {
    r.addDossierNote({ application_id: appId, kind: 'mail', content: `${SENT_NOTE[purpose]}（收件 @${emailDomain(mail.to)}${mail.attachments.length ? `，附 ${mail.attachments.length} 个附件` : ''}）` });
    tables.push('dossier_note');
    advanceOnApply(r, appId, mail, row.id, tables);
    r.recordMaterialUse({ application_id: appId, job_id: mail.payload.job_id ?? null, context: mail.payload.context ?? '邮件', content_snapshot: `${mail.payload.subject}\n\n${mail.payload.body}`, material_id: mail.payload.material_ids?.[0] ?? null });
    tables.push('material_use');
  }
  r.setActionStatus(action.id, 'done', { mail_id: row.id, message_id: messageId });
  dataChanged(deps, tables);
  if (appId) focus(deps, { surface: 'dossier', application_id: appId, note: SENT_NOTE[purpose] });
  console.log(`[career] mail-send sent action=${action.id} app=${appId ?? '-'} purpose=${purpose} domain=${emailDomain(mail.to)}`);
  return { mail_id: row.id, application_id: appId };
}

/** 校验并发送一条已批准的 send_mail 动作；返回 mail_message id。 */
export type SendOutcome = { mail_id: string; application_id: string | null } | { skipped: 'already_sent'; application_id: string | null };

export async function executeSendMailAction(deps: MailSendDeps, action: ActionQueueItem): Promise<SendOutcome> {
  if (action.kind !== 'send_mail') throw new Error(`动作 ${action.id} 不是 send_mail`);
  if (action.status !== 'approved') throw new Error(`动作 ${action.id} 尚未批准（${action.status}），不能发送`);
  const mail = await resolveOrReopen(deps, action);
  if (alreadySentApply(deps, action, mail.payload)) return { skipped: 'already_sent', application_id: mail.payload.application_id ?? action.application_id ?? null };
  checkTotalSize(deps, action, mail);
  const creds = credentialsOf(deps, action.id, mail.account);
  claimOrThrow(deps, action.id);
  checkAttachments(deps, action.id, mail);
  const messageId = await transmit(deps, action, mail.account, mail, creds);
  return recordSent(deps, action, mail.account, mail, messageId);
}

export type SendResult = { action_id: string; ok: boolean; error?: string; mail_id?: string; skipped?: 'already_sent' };

/**
 * 审核通过后立即执行所有已批准的 send_mail：逐封发，单封失败不影响其余；返回每条的结果（失败不抛，写进 result）。
 * 这份已经发过投递邮件的那封不发（ok、skipped: already_sent）。
 */
export async function executeApprovedSendMails(deps: MailSendDeps, ids: string[]): Promise<SendResult[]> {
  const out: SendResult[] = [];
  for (const id of ids) {
    const action = deps.repos.getAction(id);
    if (!action || action.kind !== 'send_mail' || action.status !== 'approved') continue;
    try {
      const res = await executeSendMailAction(deps, action);
      out.push('skipped' in res ? { action_id: id, ok: true, skipped: res.skipped } : { action_id: id, ok: true, mail_id: res.mail_id });
    }
    catch (error) { out.push({ action_id: id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return out;
}
