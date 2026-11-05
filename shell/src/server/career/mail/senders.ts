/**
 * 来信发件人的几类判断共用的常量（sync.ts 粗筛、reply-link.ts 认回与通知判定共用，不抄两份）：
 *  - 招聘系统 / 招聘平台的发件域名（代发通知，不是一个真人）；
 *  - 公共邮箱域名（域名不代表公司，不能按域名认回）。
 */

/** 招聘系统与招聘平台的发件域名（Moka、北森、牛客、HotJob、飞书招聘、智联、前程无忧、猎聘、BOSS、拉勾…）。 */
export const ATS_DOMAINS: readonly string[] = [
  'mokahr.com', 'moka.com', 'beisen.com', 'zhiye.com', 'italent.cn', 'nowcoder.com', 'hotjob.cn', 'feishu.cn', 'larksuite.com',
  'zhaopin.com', '51job.com', 'liepin.com', 'zhipin.com', 'lagou.com', 'yingjiesheng.com',
  'myworkday.com', 'workday.com', 'greenhouse.io', 'lever.co', 'successfactors.com', 'teamtailor.com', 'ashbyhq.com',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 发件串里出现招聘系统域名（「x <noreply@mokahr.com>」也认）。 */
export const ATS_SENDER_RX = new RegExp(`(?:^|[@.])(?:${ATS_DOMAINS.map(escape).join('|')})\\b`, 'i');

/**
 * 公共邮箱域名：发件人用这些域名时，域名不代表公司（qq.com 的两个地址毫无关系），不能按域名认回申请。
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'qq.com', 'vip.qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'vip.163.com', 'sina.com', 'sina.cn', 'sohu.com', '139.com', '189.cn', 'aliyun.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
]);

/** 招聘系统 / 平台的域名（含子域名，如 campus.mokahr.com）。 */
export const isAtsDomain = (domain: string): boolean => ATS_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));

/** 这个域名能不能代表一家公司（不是公共邮箱、也不是招聘系统代发）。 */
export const isCompanyDomain = (domain: string): boolean => !!domain && !PUBLIC_MAIL_DOMAINS.has(domain) && !isAtsDomain(domain);
