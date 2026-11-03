/**
 * 发送投递邮件：只能从待审队列里已批准的 send_mail 动作执行（提交与发送永远过人）。
 * 发送成功 → mail_message(out) + 卷宗笔记 + 素材使用记录 + 投递推进到 applied。
 */
import { existsSync } from 'fs';
import { basename } from 'path';
import type { Repos, ActionQueueItem, MailAccount } from '@career/core';

import { dataChanged, focus, type IntakeDeps } from '../intake';
import { fileSha256 } from '../packets';
import { serverConfig } from '../server-api';
import { getMailPassword } from './credentials';
import { remoteSend } from './remote';
import { smtpSecure } from './providers';

export interface SendMailPayload {
  account_id: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: Array<{ path: string; filename?: string; /** 批准时冻结的文件哈希（材料包） */ sha256?: string }>;
  application_id?: string | null;
  job_id?: string | null;
  material_ids?: string[];
  /** 用于素材一致性记录的场合名，缺省"邮件"。 */
  context?: string;
}

export interface MailSendDeps extends IntakeDeps {
  /** 测试注入：替代 nodemailer。 */
  transport?: (account: MailAccount, password: string, mail: SendMailPayload) => Promise<{ messageId: string | null }>;
}

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

/** 校验并发送一条已批准的 send_mail 动作；返回 mail_message id。 */
export async function executeSendMailAction(deps: MailSendDeps, action: ActionQueueItem): Promise<{ mail_id: string; application_id: string | null }> {
  const r: Repos = deps.repos;
  if (action.kind !== 'send_mail') throw new Error(`动作 ${action.id} 不是 send_mail`);
  if (action.status !== 'approved') throw new Error(`动作 ${action.id} 尚未批准（${action.status}），不能发送`);
  const payload = JSON.parse(action.payload_json || '{}') as SendMailPayload;
  const account = payload.account_id ? r.getMailAccount(payload.account_id) : r.listMailAccounts()[0];
  if (!account) throw new Error('没有可用的邮箱账号，请先在「收件箱」里绑定邮箱');
  // 云端连接：授权码在云端，经云端代发、云端留痕；本机连接：本机 SMTP 发、本机留痕
  const cloud = account.remote_id ? serverConfig(r) : null;
  const password = cloud ? '' : getMailPassword(account.id);
  if (!cloud && !password) throw new Error(`邮箱 ${account.address} 没有保存授权码，请重新绑定`);
  if (!payload.to || !payload.subject) throw new Error('收件人与主题不能为空');
  // 认领：同一封只会被发一次；批准之后内容变了会退回待审
  const claim = r.claimAction(action.id);
  if (!claim.ok) {
    dataChanged(deps, ['action_queue']);
    throw new Error(claim.reason === 'content_changed' ? '这封邮件在批准后内容有变化，已退回待审核，请重新确认' : `这封邮件已不是待发送状态（${claim.action?.status ?? '不存在'}），不会重复发送`);
  }
  // 附件必须是批准时冻结的那一份
  for (const a of payload.attachments ?? []) {
    const changedFile = !existsSync(a.path) ? '附件文件不见了' : a.sha256 && fileSha256(a.path) !== a.sha256 ? '附件内容与批准时不一致' : '';
    if (changedFile) {
      r.setActionStatus(action.id, 'failed', { error: `${changedFile}：${a.filename ?? basename(a.path)}` });
      dataChanged(deps, ['action_queue']);
      throw new Error(`${changedFile}，没有发送：${a.filename ?? basename(a.path)}`);
    }
  }
  let messageId: string | null;
  // 助理代发必须留痕：连接管理页能看到「它替我发了什么」
  const audit = { to: payload.to.split(/[,;\s]+/).filter(Boolean), subject_preview: payload.subject.slice(0, 20), trigger: action.id };
  const started = Date.now();
  const remoteId = account.remote_id;
  const transport = deps.transport ?? (cloud && remoteId ? (_a: MailAccount, _p: string, m: SendMailPayload) => remoteSend(cloud, remoteId, m, action.id) : sendViaSmtp);
  try {
    ({ messageId } = await transport(account, password ?? '', payload));
    if (!cloud) r.addMailAudit({ account_id: account.id, actor: 'agent', operation: 'send', status: 'ok', detail: audit, latency_ms: Date.now() - started });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!cloud) r.addMailAudit({ account_id: account.id, actor: 'agent', operation: 'send', status: 'failed', detail: { ...audit, error: msg.slice(0, 200) }, latency_ms: Date.now() - started });
    r.setActionStatus(action.id, 'failed', { error: msg });
    dataChanged(deps, ['action_queue']);
    throw new Error(`发送失败：${msg}`);
  }
  const appId = payload.application_id ?? action.application_id ?? null;
  const mail = r.insertMailMessage({
    account_id: account.id, uid: null, message_id: messageId, in_reply_to: null, direction: 'out',
    from_addr: account.address, to_addr: payload.to, subject: payload.subject, snippet: payload.body.slice(0, 200), body_text: payload.body,
    received_at: new Date().toISOString(), relevance: 'job', kind: null, inbox_item_id: null, application_id: appId, action_id: action.id,
  })!;
  const tables = ['action_queue', 'mail_message'];
  if (appId) {
    const app = r.getApplication(appId);
    if (app) {
      r.addDossierNote({ application_id: appId, kind: 'mail', content: `已发送投递邮件《${payload.subject}》给 ${payload.to}${payload.attachments?.length ? `，附件 ${payload.attachments.map(a => a.filename ?? basename(a.path)).join('、')}` : ''}` });
      tables.push('dossier_note');
      if (!['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired'].includes(app.stage)) {
        r.jumpTo(appId, 'applied', '邮件投递已发送', { submission_evidence: `mail:${mail.id}` });
        tables.push('application', 'application_history');
      }
    }
    r.recordMaterialUse({ application_id: appId, job_id: payload.job_id ?? null, context: payload.context ?? '邮件', content_snapshot: `${payload.subject}\n\n${payload.body}`, material_id: payload.material_ids?.[0] ?? null });
    tables.push('material_use');
  }
  r.setActionStatus(action.id, 'done', { mail_id: mail.id, message_id: messageId });
  dataChanged(deps, tables);
  if (appId) focus(deps, { surface: 'dossier', application_id: appId, note: '投递邮件已发送' });
  return { mail_id: mail.id, application_id: appId };
}

/** 审核通过后立即执行所有已批准的 send_mail；返回每条的结果（失败不抛，写进 result）。 */
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
