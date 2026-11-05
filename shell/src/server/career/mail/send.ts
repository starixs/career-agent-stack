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

/** 附件必须是批准时冻结的那一份；对不上记失败。 */
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

/** 云端连接：授权码在云端，经云端代发、云端留痕；本机连接：本机 SMTP 发、本机留痕。认领前查，缺授权码不动动作状态。 */
function credentialsOf(repos: Repos, account: MailAccount): Credentials {
  const cloud = account.remote_id ? serverConfig(repos) : null;
  const password = cloud ? '' : getMailPassword(account.id);
  if (!cloud && !password) throw new Error(`邮箱 ${account.address} 没有保存授权码，请重新绑定`);
  return { cloud, password: password ?? '' };
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

/** 发出之后：邮件记录、卷宗一笔（不写标题与全址）、素材使用（存占位符版，不存明文）、投递推进到 applied。 */
function recordSent(deps: MailSendDeps, action: ActionQueueItem, account: MailAccount, mail: ResolvedMail, messageId: string | null): { mail_id: string; application_id: string | null } {
  const r = deps.repos;
  const appId = mail.payload.application_id ?? action.application_id ?? null;
  const row = r.insertMailMessage({
    account_id: account.id, uid: null, message_id: messageId, in_reply_to: null, direction: 'out',
    from_addr: account.address, to_addr: mail.to, subject: mail.subject, snippet: mail.body.slice(0, 200), body_text: mail.body,
    received_at: new Date().toISOString(), relevance: 'job', kind: null, inbox_item_id: null, application_id: appId, action_id: action.id,
  })!;
  const tables = ['action_queue', 'mail_message'];
  const app = appId ? r.getApplication(appId) : undefined;
  if (appId && app) {
    r.addDossierNote({ application_id: appId, kind: 'mail', content: `已发出投递邮件（收件 @${emailDomain(mail.to)}${mail.attachments.length ? `，附 ${mail.attachments.length} 个附件` : ''}）` });
    tables.push('dossier_note');
    if (!['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired'].includes(app.stage)) {
      r.jumpTo(appId, 'applied', '邮件投递已发送', { submission_evidence: `mail:${row.id}` });
      tables.push('application', 'application_history');
    }
    r.recordMaterialUse({ application_id: appId, job_id: mail.payload.job_id ?? null, context: mail.payload.context ?? '邮件', content_snapshot: `${mail.payload.subject}\n\n${mail.payload.body}`, material_id: mail.payload.material_ids?.[0] ?? null });
    tables.push('material_use');
  }
  r.setActionStatus(action.id, 'done', { mail_id: row.id, message_id: messageId });
  dataChanged(deps, tables);
  if (appId) focus(deps, { surface: 'dossier', application_id: appId, note: '投递邮件已发送' });
  console.log(`[career] mail-send sent action=${action.id} app=${appId ?? '-'} domain=${emailDomain(mail.to)}`);
  return { mail_id: row.id, application_id: appId };
}

/** 校验并发送一条已批准的 send_mail 动作；返回 mail_message id。 */
export async function executeSendMailAction(deps: MailSendDeps, action: ActionQueueItem): Promise<{ mail_id: string; application_id: string | null }> {
  if (action.kind !== 'send_mail') throw new Error(`动作 ${action.id} 不是 send_mail`);
  if (action.status !== 'approved') throw new Error(`动作 ${action.id} 尚未批准（${action.status}），不能发送`);
  const mail = await resolveOrReopen(deps, action);
  const creds = credentialsOf(deps.repos, mail.account);
  claimOrThrow(deps, action.id);
  checkAttachments(deps, action.id, mail);
  const messageId = await transmit(deps, action, mail.account, mail, creds);
  return recordSent(deps, action, mail.account, mail, messageId);
}

/** 审核通过后立即执行所有已批准的 send_mail：逐封发，单封失败不影响其余；返回每条的结果（失败不抛，写进 result）。 */
export async function executeApprovedSendMails(deps: MailSendDeps, ids: string[]): Promise<Array<{ action_id: string; ok: boolean; error?: string; mail_id?: string }>> {
  const out: Array<{ action_id: string; ok: boolean; error?: string; mail_id?: string }> = [];
  for (const id of ids) {
    const action = deps.repos.getAction(id);
    if (!action || action.kind !== 'send_mail' || action.status !== 'approved') continue;
    try { const res = await executeSendMailAction(deps, action); out.push({ action_id: id, ok: true, mail_id: res.mail_id }); }
    catch (error) { out.push({ action_id: id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return out;
}
