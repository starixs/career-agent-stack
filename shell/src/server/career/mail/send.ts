/**
 * 发送投递邮件：只能从待审队列里已批准的 send_mail 动作执行（提交与发送永远过人）。
 * 发送成功 → mail_message(out) + 卷宗笔记 + 素材使用记录 + 投递推进到 applied。
 */
import { existsSync } from 'fs';
import { basename } from 'path';
import type { Repos, ActionQueueItem, MailAccount } from '@career/core';

import { dataChanged, focus, type IntakeDeps } from '../intake';
import { getMailPassword } from './credentials';
import { smtpSecure } from './providers';

export interface SendMailPayload {
  account_id: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: Array<{ path: string; filename?: string }>;
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
    attachments: (mail.attachments ?? []).filter(a => existsSync(a.path)).map(a => ({ path: a.path, filename: a.filename ?? basename(a.path) })),
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
  const password = getMailPassword(account.id);
  if (!password) throw new Error(`邮箱 ${account.address} 没有保存授权码，请重新绑定`);
  if (!payload.to || !payload.subject) throw new Error('收件人与主题不能为空');
  r.setActionStatus(action.id, 'executing');
  let messageId: string | null;
  try {
    ({ messageId } = await (deps.transport ?? sendViaSmtp)(account, password, payload));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
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
