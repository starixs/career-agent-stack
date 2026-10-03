/**
 * 邮箱同步：IMAP 拉新邮件 → mail_message → 求职相关的交给 captureIntake 归档（面试邀请 / 测评 / 拒信 / Offer 自动落卷宗）。
 * imapflow / mailparser 走动态 import：打包或依赖缺失时只影响邮箱能力，不影响侧车启动。
 */
import type { Repos, MailAccount, MailMessage } from '@career/core';

import { captureIntake, dataChanged, type IntakeDeps } from '../intake';
import { getMailPassword } from './credentials';

export interface MailSyncDeps extends IntakeDeps {
  /** 测试注入：替代真实 IMAP 拉取。 */
  fetchNew?: (account: MailAccount, password: string) => Promise<FetchedMail[]>;
  /** 首次同步回看的天数。 */
  lookbackDays?: number;
  /** 单次最多处理的邮件数。 */
  maxPerSync?: number;
}

export interface FetchedMail { uid: number; message_id: string | null; in_reply_to: string | null; from: string | null; to: string | null; subject: string | null; text: string; received_at: string | null }

export interface MailSyncResult { account_id: string; fetched: number; stored: number; job_related: number; ignored: number; archived: Array<{ mail_id: string; inbox_item_id: string; kind: string | null; summary: string }>; error?: string }

/** 求职相关的粗筛：主题 / 正文 / 发件人命中任一规则才调模型，广告与验证码不进模型。 */
const JOB_RE = /面试|笔试|测评|offer|录用|应聘|投递|简历|招聘|校招|秋招|春招|实习|人才|三方|签约|内推|hr|人力|interview|assessment|recruit|career|hiring|application|candidate|job/i;
const SENDER_RE = /mokahr|beisen|moka|zhaopin|51job|liepin|nowcoder|yingjiesheng|zhipin|lagou|hr@|hr-|talent|campus|recruit|careers|jobs|hire|workday|greenhouse|lever\.co|successfactors|teamtailor|ashby/i;
const NOISE_RE = /验证码|verification code|unsubscribe|退订|账单|invoice|订单|促销|优惠|newsletter|digest|security alert|登录提醒/i;

export function isLikelyJobMail(m: Pick<FetchedMail, 'from' | 'subject' | 'text'>): boolean {
  const head = `${m.subject ?? ''}\n${(m.text ?? '').slice(0, 600)}`;
  if (NOISE_RE.test(m.subject ?? '') && !JOB_RE.test(m.subject ?? '')) return false;
  return JOB_RE.test(head) || SENDER_RE.test(m.from ?? '');
}

async function fetchViaImap(account: MailAccount, password: string, lookbackDays: number, max: number): Promise<FetchedMail[]> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: true, auth: { user: account.address, pass: password }, logger: false });
  const out: FetchedMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids: number[];
      if (account.last_uid > 0) {
        uids = await client.search({ uid: `${account.last_uid + 1}:*` }, { uid: true }) || [];
        uids = uids.filter(u => u > account.last_uid);
      } else {
        const since = new Date(Date.now() - lookbackDays * 86_400_000);
        uids = await client.search({ since }, { uid: true }) || [];
      }
      uids = uids.sort((a, b) => a - b).slice(-max);
      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source as Buffer);
          out.push({
            uid: msg.uid,
            message_id: parsed.messageId ?? msg.envelope?.messageId ?? null,
            in_reply_to: parsed.inReplyTo ?? null,
            from: parsed.from?.text ?? msg.envelope?.from?.map(a => a.address ?? '').join(', ') ?? null,
            to: Array.isArray(parsed.to) ? parsed.to.map(t => t.text).join(', ') : parsed.to?.text ?? null,
            subject: parsed.subject ?? msg.envelope?.subject ?? null,
            text: (parsed.text ?? '').trim() || stripHtml(typeof parsed.html === 'string' ? parsed.html : ''),
            received_at: (parsed.date ?? msg.envelope?.date)?.toISOString() ?? null,
          });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => undefined); }
  return out;
}

function stripHtml(html: string): string { return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

export async function syncMailAccount(deps: MailSyncDeps, account: MailAccount): Promise<MailSyncResult> {
  const r: Repos = deps.repos;
  const result: MailSyncResult = { account_id: account.id, fetched: 0, stored: 0, job_related: 0, ignored: 0, archived: [] };
  const password = getMailPassword(account.id);
  if (!password) {
    r.updateMailAccount(account.id, { status: 'auth_failed', last_error: '没有保存授权码，请重新绑定邮箱' });
    dataChanged(deps, ['mail_account']);
    return { ...result, error: '没有保存授权码' };
  }
  let mails: FetchedMail[];
  try {
    mails = deps.fetchNew ? await deps.fetchNew(account, password) : await fetchViaImap(account, password, deps.lookbackDays ?? 14, deps.maxPerSync ?? 50);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const auth = /auth|login|credential|密码|授权/i.test(msg);
    r.updateMailAccount(account.id, { status: auth ? 'auth_failed' : 'error', last_error: msg.slice(0, 300) });
    dataChanged(deps, ['mail_account']);
    return { ...result, error: msg };
  }
  result.fetched = mails.length;
  let maxUid = account.last_uid;
  for (const m of mails) {
    maxUid = Math.max(maxUid, m.uid);
    const likely = isLikelyJobMail(m);
    const row = r.insertMailMessage({
      account_id: account.id, uid: m.uid, message_id: m.message_id, in_reply_to: m.in_reply_to, direction: 'in',
      from_addr: m.from, to_addr: m.to, subject: m.subject, snippet: m.text.slice(0, 200), body_text: m.text.slice(0, 20_000), received_at: m.received_at,
      relevance: likely ? 'unknown' : 'ignored', kind: null, inbox_item_id: null, application_id: null, action_id: null,
    });
    if (!row) continue;
    result.stored++;
    if (!likely) { result.ignored++; continue; }
    // 我们自己发出的投递邮件的回复：直接挂到同一条投递
    const replied = m.in_reply_to ? r.findMailByMessageId(m.in_reply_to) : undefined;
    const intake = await captureIntake(deps, {
      text: `主题：${m.subject ?? ''}\n发件人：${m.from ?? ''}\n\n${m.text.slice(0, 12_000)}`,
      source: 'mail', mail_message_id: row.id,
      mail: { subject: m.subject, from: m.from, received_at: m.received_at },
      application_id: replied?.application_id ?? null,
    });
    const jobRelated = intake.triage?.relevance !== 'ignored';
    const appId = intake.created.application_id ?? intake.created.closed_application_id ?? replied?.application_id ?? null;
    r.updateMailMessage(row.id, { relevance: jobRelated ? 'job' : 'ignored', kind: (intake.item.kind ?? null) as MailMessage['kind'], inbox_item_id: intake.item.id, application_id: appId });
    if (jobRelated) {
      result.job_related++;
      result.archived.push({ mail_id: row.id, inbox_item_id: intake.item.id, kind: intake.item.kind, summary: intake.summary });
      if (appId) r.addDossierNote({ application_id: appId, kind: 'mail', content: `收到邮件《${m.subject ?? '(无主题)'}》：${intake.summary}` });
    } else {
      result.ignored++;
      if (intake.item.status === 'new') r.dismissInboxItem(intake.item.id);
    }
  }
  r.updateMailAccount(account.id, { status: 'ok', last_error: null, last_sync_at: new Date().toISOString(), last_uid: maxUid });
  dataChanged(deps, ['mail_account', 'mail_message', 'inbox_item', 'dossier_note']);
  return result;
}

export async function syncAllMailAccounts(deps: MailSyncDeps): Promise<MailSyncResult[]> {
  const out: MailSyncResult[] = [];
  for (const account of deps.repos.listMailAccounts()) out.push(await syncMailAccount(deps, account));
  return out;
}
