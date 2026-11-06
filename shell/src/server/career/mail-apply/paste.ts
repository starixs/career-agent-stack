/**
 * 工作台「可以投」那一站上方的输入框：把库里没有的岗位贴进来（POST /api/career/mail-apply/jobs；合同 MailJobPaste）。
 *  - 先用规则 extractApplyEmail 找投递邮箱：没有明写就不建岗位、不调模型（「明确写发到某邮箱才走」）；
 *  - 有 → 先按兜底名字建岗位（公司 = 邮箱域名里认得出的那段，认不出「未知公司」；岗位 =「实习岗位」），
 *    再走现有的 JD 解析路径补上公司、岗位名；模型不可用或解析不出就留兜底名字——能投比名字漂亮重要；
 *  - 同一段再贴一次不重复建：去重键是 source_platform='manual' + source_job_id = 原文哈希（库里现有的去重键）。
 * 日志只记岗位 id 与收件域名。
 */
import { createHash } from 'crypto';
import { emailDomain, extractApplyEmail, type Job } from '@career/core';

import { parseAndStoreJd, type IntakeDeps } from '../intake';
import { isCompanyDomain } from '../mail/senders';

/** 贴进来的不能用：路由回 4xx 带这句。 */
export class MailJobPasteError extends Error {}

export const NO_APPLY_EMAIL = '这段里没找到投递邮箱';
const FALLBACK_COMPANY = '未知公司';
const FALLBACK_TITLE = '实习岗位';
/** 一段岗位描述最多收多少字：再长的多半是整页复制，前面这些足够认出投递邮箱和岗位。 */
const PASTE_MAX_CHARS = 20_000;
/** 域名里不代表公司名的后缀与前缀段。 */
const DOMAIN_SUFFIX_RX = /\.(com|net|org|edu|gov|co|ac)?\.?(cn|hk|tw|jp|uk|io|ai|com|net|org)$/i;
const DOMAIN_PREFIX_RX = /^(mail|hr|campus|career|careers|jobs|recruit|talent|zhaopin|m|www)\./i;

/** 邮箱域名里认得出的公司那段：hr@campus.jia.com.cn → jia；公共邮箱 / 招聘系统域名认不出。 */
export function companyFromEmail(email: string): string {
  const domain = emailDomain(email).toLowerCase();
  if (!isCompanyDomain(domain)) return FALLBACK_COMPANY;
  let core = domain.replace(DOMAIN_SUFFIX_RX, '');
  while (DOMAIN_PREFIX_RX.test(`${core}.`) && core.includes('.')) core = core.replace(DOMAIN_PREFIX_RX, '');
  return core.split('.').pop() || FALLBACK_COMPANY;
}

const pasteKey = (text: string): string => `paste:${createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;

/** 用现有的 JD 解析路径补上公司、岗位名；解析不出就留兜底名字。 */
async function nameFromJd(deps: IntakeDeps, job: Job): Promise<Job> {
  try {
    const { parsed } = await parseAndStoreJd(deps, { job_id: job.id });
    const company = parsed.company?.trim();
    const title = parsed.title?.trim();
    if (company || title) deps.repos.db.update('job', job.id, { ...(company ? { company_name: company } : {}), ...(title ? { title } : {}), updated_at: new Date().toISOString() });
  } catch (error) {
    console.warn(`[career] mail-apply paste job=${job.id} jd-parse skipped: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
  }
  return deps.repos.getJob(job.id) ?? job;
}

/** 贴进来一段岗位描述 → 岗位（已有就返回已有的那条）。 */
export async function pasteMailJob(deps: IntakeDeps, input: { text: string }): Promise<{ job: Job; created: boolean }> {
  const text = input.text.trim().slice(0, PASTE_MAX_CHARS);
  const hit = text ? extractApplyEmail(text) : null;
  if (!hit) throw new MailJobPasteError(NO_APPLY_EMAIL);
  const key = pasteKey(text);
  const existing = deps.repos.db.get<Job>(`SELECT * FROM job WHERE source_platform='manual' AND source_job_id=?`, [key]);
  if (existing) return { job: existing, created: false };
  const job = deps.repos.upsertJob({ source_platform: 'manual', source_job_id: key, title: FALLBACK_TITLE, company_name: companyFromEmail(hit.email), jd_raw: text, apply_email: hit.email });
  console.log(`[career] mail-apply paste job=${job.id} domain=${emailDomain(hit.email)}`);
  return { job: await nameFromJd(deps, job), created: true };
}
