/**
 * 发出之后的来信认回（face-mail-apply 阶段二 P2.2 / P2.3）：在 sync.ts 的粗筛之前先问「是不是我们发出的信的回音」。
 *  - 回信三级认回：① In-Reply-To 命中我们发出的信；② 发件地址 = 某封已发投递邮件的收件人（同址多份申请：主题含哪份岗位名用哪份，
 *    都不含用最近发出的那份）；③ 都不中 → 走原路径（粗筛 → 按公司岗位匹配）。
 *  - 退信：发件人 / 主题像退信通知；退的是哪封 = In-Reply-To 命中，否则最近几天发出的信里收件地址出现在退信正文里的那封。
 *    认不出是哪封的不猜，当普通邮件走原路径。
 * 只读库，不写；判断都是纯函数，方便单测。
 */
import type { MailMessage, Repos } from '@career/core';

import { isAtsDomain, isCompanyDomain } from './senders';
import type { FetchedMail } from './sync';

export type ReplyVia = 'in_reply_to' | 'sender' | 'domain';
export interface ReplyLink { application_id: string; sent: MailMessage; via: ReplyVia }

/** 退信只在最近几天发出的信里找：退信通知通常几分钟到一天内回来，3 天足够，再久的多半不是这一封。 */
export const BOUNCE_LOOKBACK_DAYS = 3;
/** 按收件地址找已发邮件最多看多少封：一个地址对应的申请不会超过这个数。 */
const SENT_BY_ADDRESS_LIMIT = 50;
/** 退信在最近几天发出的信里找，最多看多少封（一天投几十封的上限）。 */
const BOUNCE_CANDIDATE_LIMIT = 200;
const DAY_MS = 86_400_000;

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** 「HR 张 <hr@x.com>」→ hr@x.com（小写）；取不出返回 null。 */
export function bareAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = /<([^>]+)>/.exec(raw)?.[1];
  const hit = EMAIL_RX.exec(angled ?? raw)?.[0];
  return hit ? hit.toLowerCase() : null;
}

/** 回信标题：「Re: 原主题」，已经是回复的不重复加。 */
export function reSubject(subject: string | null | undefined): string {
  const s = (subject ?? '').trim();
  return /^(re|回复|答复)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
}

/** 同一个地址对应几份申请：主题里含哪份的岗位名用哪份；都不含用最近发出的那份（candidates 新的在前）。 */
export function pickBySubject<T extends { title: string }>(candidates: readonly T[], subject: string | null | undefined): T | undefined {
  const s = subject ?? '';
  return candidates.find(c => c.title && s.includes(c.title)) ?? candidates[0];
}

/** 我们发出的、挂在申请上的那封。 */
const sentOnApplication = (m: MailMessage | undefined): m is MailMessage & { application_id: string } => !!m && m.direction === 'out' && !!m.application_id;

/** ① In-Reply-To 命中我们发出的信。 */
function byInReplyTo(repos: Repos, m: Pick<FetchedMail, 'in_reply_to'>): ReplyLink | null {
  const sent = m.in_reply_to ? repos.findMailByMessageId(m.in_reply_to) : undefined;
  return sentOnApplication(sent) ? { application_id: sent.application_id, sent, via: 'in_reply_to' } : null;
}

/** 一批已发邮件 → 每份申请最近那封 → 按主题挑一份（主题含岗位名 → 最近发出的）。 */
function pickSent(repos: Repos, rows: readonly MailMessage[], subject: string | null | undefined): (MailMessage & { application_id: string }) | null {
  const latestPerApp = new Map<string, MailMessage & { application_id: string }>();
  for (const sent of rows) if (sentOnApplication(sent) && !latestPerApp.has(sent.application_id)) latestPerApp.set(sent.application_id, sent);
  const candidates = [...latestPerApp.values()].map(sent => {
    const app = repos.getApplication(sent.application_id);
    return { sent, title: (app ? repos.getJob(app.job_id)?.title : undefined) ?? '' };
  });
  return pickBySubject(candidates, subject)?.sent ?? null;
}

/** ② 发件地址 = 某封已发邮件的收件人。 */
function bySender(repos: Repos, m: Pick<FetchedMail, 'from' | 'subject'>): ReplyLink | null {
  const from = bareAddress(m.from);
  const sent = from ? pickSent(repos, repos.listMailMessages({ direction: 'out', to_addr: from, limit: SENT_BY_ADDRESS_LIMIT }), m.subject) : null;
  return sent ? { application_id: sent.application_id, sent, via: 'sender' } : null;
}

/**
 * ②′ 同公司另一个地址（第三轮 R6）：发件域名 = 某封已发邮件收件人的域名（另一位 HR、业务面试官）。
 * 公共邮箱域名、招聘系统代发域名不算（域名不代表公司，senders.ts）。
 */
function byDomain(repos: Repos, m: Pick<FetchedMail, 'from' | 'subject'>): ReplyLink | null {
  const domain = bareAddress(m.from)?.split('@')[1] ?? '';
  if (!isCompanyDomain(domain)) return null;
  const sent = pickSent(repos, repos.listMailMessages({ direction: 'out', to_domain: domain, limit: SENT_BY_ADDRESS_LIMIT }), m.subject);
  return sent ? { application_id: sent.application_id, sent, via: 'domain' } : null;
}

/** 回信认回（① → ② → ②′）；都不中返回 null（走原路径的 ③）。 */
export function linkReply(repos: Repos, m: Pick<FetchedMail, 'in_reply_to' | 'from' | 'subject'>): ReplyLink | null {
  return byInReplyTo(repos, m) ?? bySender(repos, m) ?? byDomain(repos, m);
}

const NOTIFY_LOCAL_RX = /^(no-?reply|do-?not-?reply|notifications?|notify|system|mailer|admin|service)([._+-]|$)/i;
const NOTIFY_TEXT_RX = /系统自动发送|请勿回复|此邮件由系统|do not reply|automatically generated/i;

/**
 * 通知型来信（第三轮 R4）：不是一个人在等他回话——noreply 一类的发件地址、招聘系统代发、正文写着系统自动发送 / 请勿回复。
 * 规则说是通知就不起草回信（哪怕模型判了 needs_reply）。
 */
export function isNotificationMail(m: { from: string | null; text: string | null }): boolean {
  const addr = bareAddress(m.from);
  const [local, domain] = addr ? addr.split('@') : ['', ''];
  return NOTIFY_LOCAL_RX.test(local) || (!!domain && isAtsDomain(domain)) || NOTIFY_TEXT_RX.test(m.text ?? '');
}

const BOUNCE_SENDER_RX = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const BOUNCE_SUBJECT_RX = /undeliver|delivery status notification|delivery failure|returned to (sender|mail)|退信|无法投递|投递失败|系统退信/i;

/** 像不像退信通知。 */
export function isBounce(m: Pick<FetchedMail, 'from' | 'subject'>): boolean {
  return BOUNCE_SENDER_RX.test(m.from ?? '') || BOUNCE_SUBJECT_RX.test(m.subject ?? '');
}

/** 退的是哪封：In-Reply-To 命中；否则最近 BOUNCE_LOOKBACK_DAYS 天内发出的信里，收件地址出现在退信正文里的那封（新的优先）。 */
export function locateBounced(repos: Repos, m: Pick<FetchedMail, 'in_reply_to' | 'text'>, nowIso: string): (MailMessage & { application_id: string }) | null {
  const direct = m.in_reply_to ? repos.findMailByMessageId(m.in_reply_to) : undefined;
  if (sentOnApplication(direct)) return direct;
  const since = Date.parse(nowIso) - BOUNCE_LOOKBACK_DAYS * DAY_MS;
  const text = m.text.toLowerCase();
  const hit = repos.listMailMessages({ direction: 'out', limit: BOUNCE_CANDIDATE_LIMIT })
    .filter(sentOnApplication)
    .find(s => Date.parse(s.received_at ?? s.created_at) >= since && !!s.to_addr && text.includes(s.to_addr.trim().toLowerCase()));
  return hit ?? null;
}
