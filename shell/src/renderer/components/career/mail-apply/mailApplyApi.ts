/**
 * 邮件投递的接口（合同见 shared/careerMailApply.ts）：取几封待发邮件的整张预览、改一封、存实习到岗信息、
 * 一份申请的邮件往来。
 * 整封邮件（收件人 / 标题 / 正文 / 附件名）只经这里到渲染层，不进日志：形状不对的只记动作 id。
 */
import { apiGetJson, apiPostJson } from '@/api/apiFetch';

import {
  isMailBoardRow, isMailBoardView, isMailDraftView, isMailFileOption, isMailThreadView, MAIL_APPLY_API,
  type InternAvailability, type MailBoardRow, type MailBoardView, type MailDraftPatch, type MailDraftView, type MailFileOption,
  type MailFileUpload, type MailThreadView,
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

/** 存文件的返回：存下的那个文件 + 附上之后的那封（没带 action_id 时为 null）。 */
export function parseUploaded(raw: unknown, name: string): { file: MailFileOption; draft: MailDraftView | null } {
  const file = field(raw, 'file');
  const draft = field(raw, 'draft');
  if (isMailFileOption(file) && (draft === null || draft === undefined || isMailDraftView(draft))) return { file, draft: draft ?? null };
  // 只记扩展名，文件名可能带他的名字
  console.warn('[career] mail-apply: 存文件返回的形状不对 ext=', name.split('.').pop() ?? '');
  throw new Error('没能附上，请重试');
}

/** 工作台、贴进来的岗位：形状不对整份丢掉（日志不带内容），由调用方显示「没取到」。 */
function parseOr<T>(raw: unknown, ok: (v: unknown) => v is T, what: string): T {
  if (ok(raw)) return raw;
  console.warn(`[career] mail-apply: 丢弃形状不对的${what}`);
  throw new Error(`没取到${what}，请重试`);
}

export const mailApplyApi = {
  board: () => apiGetJson<unknown>(MAIL_APPLY_API.board).then(r => parseOr<MailBoardView>(field(r, 'board'), isMailBoardView, '邮件投递')),
  /** 贴一段岗位：没有明写投递邮箱时服务端回 4xx，错误字原样给人看。 */
  pasteJob: (text: string) => apiPostJson<unknown>(MAIL_APPLY_API.jobs, { text }).then(r => parseOr<MailBoardRow>(field(r, 'row'), isMailBoardRow, '这个岗位')),
  drafts: (actionIds: readonly string[]) =>
    apiGetJson<unknown>(`${MAIL_APPLY_API.drafts}?ids=${encodeURIComponent(actionIds.join(','))}`).then(r => parseDrafts(field(r, 'drafts'))),
  patch: (actionId: string, patch: MailDraftPatch) =>
    apiPostJson<unknown>(MAIL_APPLY_API.draft(actionId), patch).then(r => parseOne(field(r, 'draft'), actionId)),
  availability: (value: InternAvailability) =>
    apiPostJson<unknown>(MAIL_APPLY_API.availability, value).then(r => parseDrafts(field(r, 'drafts'))),
  upload: (upload: MailFileUpload) =>
    apiPostJson<unknown>(MAIL_APPLY_API.files, upload).then(r => parseUploaded(r, upload.name)),
  thread: (applicationId: string) =>
    apiGetJson<unknown>(MAIL_APPLY_API.thread(applicationId)).then(r => parseThread(field(r, 'thread'), applicationId)),
};
