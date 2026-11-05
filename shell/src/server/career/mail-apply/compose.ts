/**
 * 投递邮件里由代码拼的几样（不让模型写：模型拿不到、也不该猜；不变量 8）：
 *  - 到岗那句：实习岗位三项齐 → 「我每周可实习 X 天，可连续实习 X 个月，最早 X 到岗。简历见附件，期待您的回复。」；否则只说简历见附件；
 *  - 署名：姓名 / 学校 / 电话（姓名、电话用私密库占位符，预览与发送时在本机解开）；
 *  - 默认标题：`应聘【岗位】-学校-姓名-每周X天-可实习X个月`（非实习去掉实习字段），到岗信息变了能重排；
 *  - 附件名：JD 指定格式优先，默认 `学校-姓名-专业-年级.pdf`，不合格退回 `姓名-学校-岗位.pdf`。
 * 纯函数；资料由调用方从私密库的非敏感字段读好传进来。
 */
import { vaultPlaceholder, VAULT_PLACEHOLDER_RX, type Job, type Vault } from '@career/core';

import type { InternAvailability } from '../../../shared/careerMailApply';

export const NAME_TOKEN = vaultPlaceholder('profile', '', 'name');
export const PHONE_TOKEN = vaultPlaceholder('profile', '', 'phone');

/** 私密库里非敏感的几项（明文可以写进邮件、也可以给模型看）。 */
export interface MailProfile { school?: string; major?: string; graduation?: string }

/** 存到岗信息用的私密库字段（core vault.ts PROFILE_FIELDS）。 */
export const AVAILABILITY_FIELDS = { days_per_week: 'internDaysPerWeek', months: 'internMonths', start: 'availableDate' } as const;

const text = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** 从私密库的非敏感字段读出邮件要用的资料与到岗信息（不写访问日志：非敏感项本来就可以进模型上下文）。 */
export function readMailProfile(vault: Vault | null): { profile: MailProfile; availability: InternAvailability } {
  const basics = vault?.profileSafeBasics() ?? {};
  return {
    profile: { school: text(basics.school) ?? undefined, major: text(basics.major) ?? undefined, graduation: text(basics.graduation) ?? undefined },
    availability: {
      days_per_week: text(basics[AVAILABILITY_FIELDS.days_per_week]),
      months: text(basics[AVAILABILITY_FIELDS.months]),
      start: text(basics[AVAILABILITY_FIELDS.start]),
    },
  };
}

/**
 * 回信 / 跟进里需要他补的空（资料里没有、不许编的那一处）：模型写成「【待补：缺什么】」，
 * 预览里原样给他看，blockers 带 unresolved，他改掉才能发。
 */
export const GAP_RX = /【待补[:：][^】]*】/;
export const hasGap = (text: string): boolean => GAP_RX.test(text);
export const gapOf = (what: string): string => `【待补：${what}】`;

export const isAvailabilityComplete = (a: InternAvailability): boolean => !!(a.days_per_week && a.months && a.start);

/** 这份投递要不要问到岗信息：实习岗位的投递邮件才问。 */
export const isInternJob = (job: Pick<Job, 'employment_type'> | null | undefined): boolean => job?.employment_type === 'intern';

export const ARRIVAL_TAIL = '简历见附件，期待您的回复。';

/** 到岗那句（正文第三段）。 */
export function arrivalLine(intern: boolean, a: InternAvailability): string {
  if (!intern || !isAvailabilityComplete(a)) return ARRIVAL_TAIL;
  const start = a.start === '随时' ? '随时可以到岗' : `最早${a.start}到岗`;
  return `我每周可实习${a.days_per_week}天，可连续实习${a.months}个月，${start}。${ARRIVAL_TAIL}`;
}

/** 署名：姓名 / 学校 / 电话。 */
export function signature(profile: MailProfile): string {
  return [NAME_TOKEN, profile.school, PHONE_TOKEN].filter((x): x is string => !!x).join('\n');
}

/** 默认标题（JD 没指定格式时）。 */
export function defaultSubject(title: string, intern: boolean, profile: MailProfile, a: InternAvailability): string {
  const parts = [`应聘【${title}】`, profile.school, NAME_TOKEN];
  if (intern && a.days_per_week) parts.push(`每周${a.days_per_week}天`);
  if (intern && a.months) parts.push(`可实习${a.months}个月`);
  return parts.filter((x): x is string => !!x).join('-');
}

/** 正文 = 模型写的前两段 + 代码拼的到岗那句 + 署名。 */
export function assembleBody(intro: string, arrival: string, sign: string): string {
  return [intro.trim(), arrival, sign].filter(Boolean).join('\n\n');
}

/** 文件名里一段：去掉路径分隔符和文件系统不认的字符。 */
const filePart = (v: string | undefined): string => (v ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').trim();

/** 年级：从毕业时间里取年份说成「2027届」；没有就不写。 */
export function gradeOf(graduation: string | undefined): string | undefined {
  const year = /(20\d{2})/.exec(graduation ?? '')?.[1];
  return year ? `${year}届` : undefined;
}

/** 附件名合格：以 .pdf 结尾、没有路径分隔符、除私密库占位符外没有花括号。 */
export function isValidAttachmentName(name: string): boolean {
  const bare = name.replace(new RegExp(VAULT_PLACEHOLDER_RX.source, 'g'), 'x');
  return /\.pdf$/i.test(name) && !/[\\/]/.test(name) && !/[{}]/.test(bare) && bare.length > '.pdf'.length;
}

export function defaultAttachmentName(profile: MailProfile): string {
  return `${[filePart(profile.school), NAME_TOKEN, filePart(profile.major), gradeOf(profile.graduation)].filter(Boolean).join('-')}.pdf`;
}

/** 兜底附件名：`姓名-学校-岗位.pdf`。 */
export function fallbackAttachmentName(profile: MailProfile, title: string): string {
  return `${[NAME_TOKEN, filePart(profile.school), filePart(title)].filter(Boolean).join('-')}.pdf`;
}

/** JD 指定格式时用模型按格式填好的名字；不合格或没指定就用默认，默认也不合格退回兜底。 */
export function chooseAttachmentName(fromModel: string | undefined, jdFormat: string | undefined, profile: MailProfile, title: string): string {
  const candidates = [jdFormat && fromModel ? fromModel.trim() : '', defaultAttachmentName(profile)];
  return candidates.find(n => n && isValidAttachmentName(n)) ?? fallbackAttachmentName(profile, title);
}
