/**
 * 邮件投递的接口（合同见 shared/careerMailApply.ts）：取几封待发邮件的整张预览、改一封、存实习到岗信息、
 * 一份申请的邮件往来。
 * 整封邮件（收件人 / 标题 / 正文 / 附件名）只经这里到渲染层，不进日志：形状不对的只记动作 id。
 */
import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import {
  isMailDraftView, isMailThreadView, MAIL_APPLY_API,
  type InternAvailability, type MailDraftPatch, type MailDraftView, type MailThreadView,
} from '../../../../shared/careerMailApply';

const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const field = (res: unknown, key: string): unknown => (isDict(res) ? res[key] : undefined);

const idOf = (v: unknown): string => {
  const id = field(v, 'action_id');
  return typeof id === 'string' ? id : '(无 id)';
};

/** 只留形状对的；丢掉的留一条带动作 id 的日志，不猜字段。 */
export function parseDrafts(raw: unknown): MailDraftView[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.warn('[career] mail-apply: drafts 不是数组，丢弃');
    return [];
  }
  return raw.filter((d): d is MailDraftView => {
    if (isMailDraftView(d)) return true;
    console.warn('[career] mail-apply: 丢弃形状不对的邮件预览 action=', idOf(d));
    return false;
  });
}

function parseOne(raw: unknown, actionId: string): MailDraftView {
  if (isMailDraftView(raw)) return raw;
  console.warn('[career] mail-apply: 改完返回的邮件预览形状不对 action=', actionId);
  throw new Error('没能保存，请重试');
}

/** 往来形状不对：整份丢掉（只记申请 id），由调用方显示「没取到」，不拼半份。 */
export function parseThread(raw: unknown, applicationId: string): MailThreadView {
  if (isMailThreadView(raw)) return raw;
  console.warn('[career] mail-apply: 丢弃形状不对的邮件往来 app=', applicationId);
  throw new Error('没取到这份的邮件往来');
}

export const mailApplyApi = {
  drafts: (actionIds: readonly string[]) =>
    apiGetJson<unknown>(`${MAIL_APPLY_API.drafts}?ids=${encodeURIComponent(actionIds.join(','))}`).then(r => parseDrafts(field(r, 'drafts'))),
  patch: (actionId: string, patch: MailDraftPatch) =>
    apiPostJson<unknown>(MAIL_APPLY_API.draft(actionId), patch).then(r => parseOne(field(r, 'draft'), actionId)),
  availability: (value: InternAvailability) =>
    apiPostJson<unknown>(MAIL_APPLY_API.availability, value).then(r => parseDrafts(field(r, 'drafts'))),
  thread: (applicationId: string) =>
    apiGetJson<unknown>(MAIL_APPLY_API.thread(applicationId)).then(r => parseThread(field(r, 'thread'), applicationId)),
};
