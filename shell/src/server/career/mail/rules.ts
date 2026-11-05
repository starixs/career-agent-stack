/**
 * 历史求职邮件的规则分类：第一次连邮箱时要把几个月的邮件收进来，逐封调模型太慢也太贵。
 * 招聘系统的邮件特征很明显（主题里写着笔试 / 面试 / 感谢投递，发件人是公司校招），
 * 这里只认特征明确的几类；认不准就返回 null，交给调用方决定是否调模型。
 */
import type { TriageResult } from '../intake';

import type { FetchedMail } from './sync';

/** 按主题判类型，顺序就是优先级：「面试结果：很遗憾」先算拒信，「录用」先于「面试」。 */
const KIND_RULES: Array<{ kind: NonNullable<TriageResult['kind']>; re: RegExp }> = [
  { kind: 'rejection', re: /很遗憾|感谢信|未能通过|未通过|不合适|流程(已)?终止|unfortunately|regret to inform/i },
  { kind: 'offer', re: /录用(通知|意向)|offer letter|意向书|签约通知|录取通知|拟录用/i },
  { kind: 'interview_invite', re: /面试(邀请|通知|安排|邀约|提醒)|邀请您参加.{0,8}面|interview invitation/i },
  { kind: 'written_test', re: /笔试|机考|在线考试|coding test|online test/i },
  { kind: 'assessment', re: /测评|性格测试|在线评估|AI\s*面试|assessment/i },
  { kind: 'application_received', re: /已收到(您|你)的(简历|申请)|投递成功|申请(已)?提交成功|感谢(您|你)的?(投递|申请|关注)|application (received|submitted)|thank you for (your )?appl/i },
];

/** 主题里的公司：【美团】/「美团」/ 美团2026校园招聘 / 美团-校招。 */
const SUBJECT_COMPANY = [
  /[【「[]([^】」\]]{2,20}?)(?:校园招聘|校招|招聘|集团)?[】」\]]/,
  /^([一-龥A-Za-z]{2,12}?)(?:集团|公司)?\s*(?:20\d{2}(?:届)?)?\s*(?:校园招聘|校招|秋招|春招|实习生?招聘|招聘)/,
];
/** 发件人名字里的公司：「美团校园招聘 <noreply@mokahr.com>」。 */
const SENDER_COMPANY = /^"?([一-龥A-Za-z]{2,12}?)(?:集团|公司)?\s*(?:校园招聘|校招|招聘|人力资源|HR|Talent|Careers?|Recruiting)/i;
/** 不是公司名的通用词：招聘平台、泛称。 */
const NOT_COMPANY = /^(?:mokahr|moka|北森|beisen|牛客|nowcoder|智联|前程无忧|猎聘|boss|通知|系统|noreply|no-reply|招聘|校园|HR|您好)$/i;

function cleanCompany(raw: string | undefined): string | null {
  const name = raw?.trim().replace(/(?:集团|有限公司|公司)$/, '');
  return name && !NOT_COMPANY.test(name) ? name : null;
}

export function companyOf(m: Pick<FetchedMail, 'subject' | 'from'>): string | null {
  for (const re of SUBJECT_COMPANY) {
    const hit = cleanCompany(re.exec(m.subject ?? '')?.[1]);
    if (hit) return hit;
  }
  return cleanCompany(SENDER_COMPANY.exec(m.from ?? '')?.[1]);
}

/** 正文里第一个「X月X日 HH:MM」或「YYYY-MM-DD HH:MM」，交给 normalizeIso 按收件时间补年份。 */
const WHEN_RE = /(?:20\d{2}[-/年])?\d{1,2}[-/月]\d{1,2}日?(?:\s*(?:[（(][^）)]{1,4}[）)])?\s*\d{1,2}[:：]\d{2})?/;

/** 能认出类型和公司才返回；岗位名规则抽不准，留空。 */
export function classifyByRules(m: Pick<FetchedMail, 'subject' | 'from' | 'text'>): TriageResult | null {
  const subject = m.subject ?? '';
  const rule = KIND_RULES.find(r => r.re.test(subject));
  const company = companyOf(m);
  if (!rule || !company) return null;
  const when = rule.kind === 'interview_invite' || rule.kind === 'written_test' || rule.kind === 'assessment'
    ? WHEN_RE.exec(m.text ?? '')?.[0]
    : undefined;
  return { kind: rule.kind, relevance: 'job', confidence: 0.7, fields: { company, ...(when ? { when } : {}) }, summary: `${company} ${subject}`.slice(0, 80) };
}

/** 自动回复只看主题和正文开头这么多字：自动回复的话都在最前面，后面多半引用了原信。 */
const AUTO_REPLY_HEAD_CHARS = 200;
const AUTO_REPLY_RX = /自动回复|auto(matic)?[- ]?reply|out of office|已收到(您|你)的(邮件|来信)/i;

/** 自动回复（P2.4）：只当投递确认，不算回音（阶段不动、不挡跟进、不起草回信）。 */
export function isAutoReply(m: Pick<FetchedMail, 'subject' | 'text'>): boolean {
  return AUTO_REPLY_RX.test(m.subject ?? '') || AUTO_REPLY_RX.test((m.text ?? '').slice(0, AUTO_REPLY_HEAD_CHARS));
}

/** 认回到我们发出的信上的自动回复：规则直接判成投递确认，不调模型。 */
export function autoReplyTriage(m: Pick<FetchedMail, 'subject'>, company: string | null): TriageResult {
  return { kind: 'application_received', relevance: 'job', confidence: 1, fields: company ? { company } : {}, summary: `${company ? `${company} ` : ''}自动回复：${m.subject ?? ''}`.slice(0, 80) };
}
