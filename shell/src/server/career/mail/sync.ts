/**
 * 邮箱同步：IMAP 拉新邮件 → mail_message → 求职相关的交给 captureIntake 归档（面试邀请 / 测评 / 拒信 / Offer 自动落卷宗）。
 * 第一次同步是历史导入：回看几个月，只拉信头粗筛，命中的再拉正文；规则认得出的直接落库不调模型，
 * 只有最近两周、可能还没发生的事才调模型抽准确时间。
 * imapflow / mailparser 走动态 import：打包或依赖缺失时只影响邮箱能力，不影响侧车启动。
 */
import type { Repos, MailAccount, MailMessage } from '@career/core';

import { captureIntake, captureTriaged, dataChanged, type IntakeDeps, type IntakeInput, type IntakeResult } from '../intake';
import type { PostChatCard } from '../chat-card-push';
import { recordBusinessEventInBackground } from '../billing-service';
import { getMailPassword } from './credentials';
import { isExpired, recordMailFailure, recordMailSuccess } from './health';
import { afterLinkedReply, handleBounceMail } from '../mail-apply/after-send';
import { linkReply } from './reply-link';
import { ATS_SENDER_RX } from './senders';
import { autoReplyTriage, classifyByRules, isAutoReply } from './rules';
import { recordTakeover } from './takeover';
import { extractCode } from '../phone/sms-code';

export interface MailSyncDeps extends IntakeDeps {
  /** 后台往个人助理对话里放卡（接管卡）；缺省不放（测试、没有对话的场合）。 */
  postChatCard?: PostChatCard;
  /** 测试注入：替代真实 IMAP 拉取（历史导入时传回的就是粗筛前的全部邮件）。 */
  fetchNew?: (account: MailAccount, password: string) => Promise<FetchedMail[]>;
}

/** 第一次连邮箱回看多久：秋招从提前批到结束大约半年。 */
export const HISTORY_LOOKBACK_DAYS = 180;
/** 历史导入最多处理多少封粗筛命中的邮件：关键期两三百份投递、每份几封通知。 */
export const HISTORY_MAX_CANDIDATES = 1_000;
/** 这几天内的面试 / 笔试 / Offer 可能还没发生，调模型抽准确时间；更早的只用规则。 */
export const FRESH_DAYS = 14;
/** 之后每次同步：只拉上次之后的新邮件，最多这么多封（轮询每 5 分钟一次）。 */
const INCREMENTAL_MAX = 50;

export interface FetchedMail { uid: number; message_id: string | null; in_reply_to: string | null; from: string | null; to: string | null; subject: string | null; text: string; received_at: string | null }

export interface MailSyncResult {
  account_id: string; fetched: number; stored: number; job_related: number; ignored: number;
  archived: Array<{ mail_id: string; inbox_item_id: string; kind: string | null; summary: string }>;
  /** 认回到我们发出的信上的封数（回复关系 / 发件人 / 同公司域名）与这一轮各种归类的封数（日志锚点用，只有计数）。 */
  linked?: number;
  kinds?: Record<string, number>;
  /** 历史导入：规则直接收下的、调了模型的、认不出留着没动的。 */
  /** 历史导入：规则直接收下的、调了模型的、认不出留着没动的，以及接管到的申请（接管简报用）。 */
  history?: { by_rules: number; by_model: number; unclassified: number; application_ids: string[] };
  error?: string;
}

/** 求职相关的粗筛：主题 / 正文 / 发件人命中任一规则才调模型，广告与验证码不进模型。 */
const JOB_RE = /面试|笔试|测评|offer|录用|应聘|投递|简历|招聘|校招|秋招|春招|实习|人才|三方|签约|内推|hr|人力|interview|assessment|recruit|career|hiring|application|candidate|job/i;
/** 招聘系统域名（senders.ts 共用）之外，发件串里像招聘方的词。 */
const SENDER_WORDS_RE = /hr@|hr-|talent|campus|recruit|careers|jobs|hire/i;
const isRecruiterSender = (from: string): boolean => ATS_SENDER_RX.test(from) || SENDER_WORDS_RE.test(from);
const NOISE_RE = /验证码|verification code|unsubscribe|退订|账单|invoice|订单|促销|优惠|newsletter|digest|security alert|登录提醒/i;

const OTP_RE = /验证码|校验码|动态码|one[- ]time (?:code|password)|verification code|security code|\botp\b/i;
export function isVerificationMail(m: Pick<FetchedMail, 'subject' | 'text'>): boolean {
  const text = `${m.subject ?? ''}\n${m.text}`;
  return OTP_RE.test(m.subject ?? '') || (OTP_RE.test(text) && extractCode(text) !== null);
}

export function isLikelyJobMail(m: Pick<FetchedMail, 'from' | 'subject' | 'text'>): boolean {
  if (isVerificationMail(m)) return false;
  const head = `${m.subject ?? ''}\n${(m.text ?? '').slice(0, 600)}`;
  if (NOISE_RE.test(m.subject ?? '') && !JOB_RE.test(m.subject ?? '')) return false;
  return JOB_RE.test(head) || isRecruiterSender(m.from ?? '');
}

type ImapClient = InstanceType<typeof import('imapflow').ImapFlow>;

export async function withInbox<T>(account: MailAccount, password: string, fn: (client: ImapClient) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: true, auth: { user: account.address, pass: password }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try { return await fn(client); } finally { lock.release(); }
  } finally { await client.logout().catch(() => undefined); }
}

export async function fetchBodies(client: ImapClient, uids: number[]): Promise<FetchedMail[]> {
  const { simpleParser } = await import('mailparser');
  const out: FetchedMail[] = [];
  if (!uids.length) return out;
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
  return out;
}

/** reset：UIDVALIDITY 变了（邮箱重建过），旧游标作废，这次按历史导入重来。 */
interface Fetched { mails: FetchedMail[]; maxUid: number; uidvalidity: number | null; reset?: boolean }

function uidValidityOf(client: ImapClient): number | null {
  const box = client.mailbox;
  return box && box.uidValidity !== undefined ? Number(box.uidValidity) : null;
}

/** 增量：上次之后的新邮件。UIDVALIDITY 变了就当第一次连，重新做历史导入（不然游标对不上，永远拉不到新信）。 */
function fetchIncremental(account: MailAccount, password: string): Promise<Fetched> {
  return withInbox(account, password, async client => {
    const uidvalidity = uidValidityOf(client);
    if (account.uidvalidity && uidvalidity && uidvalidity !== account.uidvalidity) {
      console.warn(`[career-mail] uidvalidity changed account=${account.id} ${account.uidvalidity} -> ${uidvalidity}, reimporting history`);
      return { ...(await historyIn(client, account)), reset: true };
    }
    const uids = ((await client.search({ uid: `${account.last_uid + 1}:*` }, { uid: true })) || []).filter(u => u > account.last_uid).sort((a, b) => a - b);
    return { mails: await fetchBodies(client, uids.slice(-INCREMENTAL_MAX)), maxUid: uids.at(-1) ?? account.last_uid, uidvalidity };
  });
}

function fetchHistory(account: MailAccount, password: string): Promise<Fetched> {
  return withInbox(account, password, client => historyIn(client, account));
}

/** 历史：几个月内的信头全拉（很便宜），粗筛命中的才拉正文。 */
async function historyIn(client: ImapClient, account: MailAccount): Promise<Fetched> {
  const since = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 86_400_000);
  const uids = ((await client.search({ since }, { uid: true })) || []).sort((a, b) => a - b);
  const candidates: number[] = [];
  if (uids.length) {
    for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      const from = msg.envelope?.from?.map(a => `${a.name ?? ''} <${a.address ?? ''}>`).join(', ') ?? null;
      if (isLikelyJobMail({ from, subject: msg.envelope?.subject ?? null, text: '' })) candidates.push(msg.uid);
    }
  }
  const picked = candidates.sort((a, b) => a - b).slice(-HISTORY_MAX_CANDIDATES);
  console.log(`[career-mail] history scan account=${account.id} scanned=${uids.length} candidates=${candidates.length} picked=${picked.length}`);
  return { mails: await fetchBodies(client, picked), maxUid: uids.at(-1) ?? 0, uidvalidity: uidValidityOf(client) };
}

function stripHtml(html: string): string { return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

const inflight = new Map<string, Promise<MailSyncResult>>();

/** 同一个账号同时只跑一次：后台历史导入还没完时，5 分钟轮询不要再开一遍。 */
export function syncMailAccount(deps: MailSyncDeps, account: MailAccount): Promise<MailSyncResult> {
  const running = inflight.get(account.id);
  if (running) return running;
  const task = runSync(deps, account).finally(() => inflight.delete(account.id));
  inflight.set(account.id, task);
  return task;
}

async function fetchMails(deps: MailSyncDeps, account: MailAccount, password: string, history: boolean): Promise<Fetched> {
  if (deps.fetchNew) {
    const mails = await deps.fetchNew(account, password);
    return { mails, maxUid: mails.reduce((n, m) => Math.max(n, m.uid), account.last_uid), uidvalidity: null };
  }
  return history ? fetchHistory(account, password) : fetchIncremental(account, password);
}

/** 已失效的连接不再自动登录，提示重新授权。 */
export const EXPIRED_MESSAGE = '邮箱连接已失效，需要重新授权';

async function runSync(deps: MailSyncDeps, account: MailAccount): Promise<MailSyncResult> {
  const r: Repos = deps.repos;
  const result: MailSyncResult = { account_id: account.id, fetched: 0, stored: 0, job_related: 0, ignored: 0, archived: [] };
  if (isExpired(account)) return { ...result, error: EXPIRED_MESSAGE };
  const password = getMailPassword(account.id);
  if (!password) {
    r.updateMailAccount(account.id, { status: 'auth_failed', last_error: '没有保存授权码，请重新授权' });
    dataChanged(deps, ['mail_account']);
    return { ...result, error: '没有保存授权码' };
  }
  const started = Date.now();
  let fetched: Fetched;
  try {
    fetched = await fetchMails(deps, account, password, account.last_uid === 0);
  } catch (error) {
    const message = recordMailFailure(deps, account, error);
    r.addMailAudit({ account_id: account.id, actor: 'system', operation: 'sync', status: 'failed', detail: { error: message }, latency_ms: Date.now() - started });
    return { ...result, error: message };
  }
  const history = account.last_uid === 0 || !!fetched.reset;
  Object.assign(result, await archiveBatch(deps, account, fetched.mails, history));
  if (history) recordTakeover(deps, account, result, fetched.mails);
  recordMailSuccess(deps, account, { last_uid: fetched.reset ? fetched.maxUid : Math.max(account.last_uid, fetched.maxUid), uidvalidity: fetched.uidvalidity });
  // 每 5 分钟一次的空同步不留痕，只记真拉到信的（连接管理页的用量）
  if (result.fetched) r.addMailAudit({ account_id: account.id, actor: 'system', operation: history ? 'import' : 'sync', status: 'ok', detail: { fetched: result.fetched, job_related: result.job_related, ...(result.history ?? {}) }, latency_ms: Date.now() - started });
  dataChanged(deps, ['mail_account', 'mail_message', 'inbox_item', 'dossier_note', 'job', 'application', 'application_history', 'interview', 'offer', 'deadline']);
  if (result.history) console.log(`[career-mail] history import account=${account.id} fetched=${result.fetched} rules=${result.history.by_rules} model=${result.history.by_model} unclassified=${result.history.unclassified}`);
  return result;
}

/**
 * 一批邮件 → 落库 → 归档 / 接管。本机 IMAP 同步和云端事件流（mail/remote.ts）共用。
 * history：第一次连接的历史邮件，规则先认、按时间从旧到新处理（先投递确认、再笔试面试、最后拒信 / Offer，阶段才推得对）。
 */
export async function archiveBatch(deps: MailSyncDeps, account: MailAccount, mails: FetchedMail[], history: boolean): Promise<MailSyncResult> {
  const result: MailSyncResult = { account_id: account.id, fetched: mails.length, stored: 0, job_related: 0, ignored: 0, archived: [], ...(history ? { history: { by_rules: 0, by_model: 0, unclassified: 0, application_ids: [] } } : {}) };
  const ordered = history ? [...mails].sort((a, b) => (a.received_at ?? '').localeCompare(b.received_at ?? '')) : mails;
  for (const m of ordered) await archiveMail(deps, account, m, result);
  return result;
}

/** 来信落库（同账号同 uid / Message-ID 只存一次，已存在返回 null）。 */
function storeIncoming(r: Repos, account: MailAccount, m: FetchedMail, relevance: MailMessage['relevance'], applicationId: string | null): MailMessage | null {
  return r.insertMailMessage({
    account_id: account.id, uid: m.uid, message_id: m.message_id, in_reply_to: m.in_reply_to, direction: 'in',
    from_addr: m.from, to_addr: m.to, subject: m.subject, snippet: m.text.slice(0, 200), body_text: m.text.slice(0, 20_000), received_at: m.received_at,
    relevance, kind: null, inbox_item_id: null, application_id: applicationId, action_id: null,
  });
}

async function archiveMail(deps: MailSyncDeps, account: MailAccount, m: FetchedMail, result: MailSyncResult): Promise<void> {
  const r = deps.repos;
  // 收码只由私有等待通道消费；包括带「招聘」字样的码邮件，不落求职库、不进模型。
  if (isVerificationMail(m)) { result.ignored++; return; }
  // 我们发出的投递邮件被退回：撤回投出、排一封待改收件人的重发，不进归档（历史导入不处理：早已过去）
  if (!result.history && handleBounceMail(deps, account, m)) { result.stored++; result.job_related++; return; }
  // 我们发出的信的回音（回复关系 / 发件人 = 当初收件人）：跳过粗筛——HR 私人口吻的信未必命中关键词
  const link = linkReply(r, m);
  const likely = !!link || isLikelyJobMail(m);
  // 历史导入不存无关邮件：几个月的私人邮件没必要进库
  if (result.history && !likely) { result.ignored++; return; }
  if (link) result.linked = (result.linked ?? 0) + 1;
  const row = storeIncoming(r, account, m, likely ? 'unknown' : 'ignored', link?.application_id ?? null);
  if (!row) return;
  result.stored++;
  if (!likely) { result.ignored++; return; }
  const input: IntakeInput = {
    text: `主题：${m.subject ?? ''}\n发件人：${m.from ?? ''}\n\n${m.text.slice(0, 12_000)}`,
    source: 'mail', mail_message_id: row.id,
    mail: { subject: m.subject, from: m.from, received_at: m.received_at },
    application_id: link?.application_id ?? null,
  };
  const auto = !!link && isAutoReply(m);
  // 认回的自动回复规则直接判成投递确认，不调模型；它不算回音
  const intake = auto ? await captureTriaged(deps, input, autoReplyTriage(m, companyOfApplication(r, link.application_id))) : await triageMail(deps, m, input, result);
  if (!intake) return;
  recordArchived(deps, m, row, intake, input, result, link?.application_id ?? null);
  if (link && !auto && !result.history) afterLinkedReply(deps, link.application_id, r.getMailMessage(row.id) ?? row, intake.triage);
}

const companyOfApplication = (r: Repos, appId: string): string | null => {
  const app = r.getApplication(appId);
  return app ? r.getJob(app.job_id)?.company_name ?? null : null;
};

/** 归档结果写回这封邮件、计数、卷宗一笔。 */
function recordArchived(deps: MailSyncDeps, m: FetchedMail, row: MailMessage, intake: IntakeResult, input: IntakeInput, result: MailSyncResult, linkedApp: string | null): void {
  const r = deps.repos;
  const jobRelated = linkedApp !== null || intake.triage?.relevance !== 'ignored';
  const appId = intake.created.application_id ?? intake.created.closed_application_id ?? linkedApp;
  r.updateMailMessage(row.id, { relevance: jobRelated ? 'job' : 'ignored', kind: (intake.item.kind ?? null) as MailMessage['kind'], inbox_item_id: intake.item.id, application_id: appId });
  if (jobRelated && appId && result.history && !result.history.application_ids.includes(appId)) result.history.application_ids.push(appId);
  if (jobRelated) {
    result.job_related++;
    const kind = intake.item.kind ?? 'other';
    result.kinds = { ...result.kinds, [kind]: (result.kinds?.[kind] ?? 0) + 1 };
    // 卖点埋点：一封求职邮件认出来并归档算一件（按邮件行幂等）
    recordBusinessEventInBackground({ event: 'mail_triaged', key: `mail:${row.id}`, refType: 'mail_message', refId: row.id, meta: { kind: intake.item.kind, history: !!input.history } }, r.db);
    if (!input.history) result.archived.push({ mail_id: row.id, inbox_item_id: intake.item.id, kind: intake.item.kind, summary: intake.summary });
    if (appId) r.addDossierNote({ application_id: appId, kind: 'mail', content: `收到邮件《${m.subject ?? '(无主题)'}》：${intake.summary}` });
  } else {
    result.ignored++;
    if (intake.item.status === 'new') r.dismissInboxItem(intake.item.id);
  }
}

/**
 * 增量同步全部走模型。历史导入：最近两周里可能还没发生的事走模型；其余规则认得出就直接收，
 * 认不出就留着不动（那家以后来信再补建）。投递确认不需要时间，再新也走规则。
 */
async function triageMail(deps: MailSyncDeps, m: FetchedMail, input: IntakeInput, result: MailSyncResult): Promise<IntakeResult | null> {
  const stats = result.history;
  if (!stats) return captureIntake(deps, input);
  const rule = classifyByRules(m);
  const nowMs = Date.parse(deps.now?.() ?? new Date().toISOString());
  const fresh = !!m.received_at && Date.parse(m.received_at) >= nowMs - FRESH_DAYS * 86_400_000;
  if (fresh && deps.llm && rule?.kind !== 'application_received') {
    stats.by_model++;
    return captureIntake(deps, input);
  }
  if (!rule) { stats.unclassified++; return null; }
  stats.by_rules++;
  input.history = !fresh || rule.kind === 'application_received';
  return captureTriaged(deps, input, rule);
}

export async function syncAllMailAccounts(deps: MailSyncDeps): Promise<MailSyncResult[]> {
  const out: MailSyncResult[] = [];
  // 失效的连接跳过：不拿错的授权码反复登录
  for (const account of deps.repos.listMailAccounts()) if (!isExpired(account)) out.push(await syncMailAccount(deps, account));
  return out;
}
