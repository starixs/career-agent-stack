/**
 * 邮件投递（face-mail-apply 2026-11-05）：前后端共用的形状。
 *
 * 邮件投递和网申同构：后台写邮件（draft_mail，对应 fill_form）→ 发前过目（send_mail，对应 submit）。
 * 一封待发的邮件 = 一个 pending_review 的 send_mail 动作；预览、改、发出都按动作 id。
 *
 * 明文边界：整封邮件（收件人、标题、正文、附件名）只经 /api/career/mail-apply/* 给渲染层，
 * 不进 AskView、不进对话卡片数据、不进模型上下文、不进日志。AskView 上只带 AskMail（没有邮件内容）。
 */

/** 这封邮件是干什么的：投递、没回音的跟进、回 HR 的信。 */
export type MailPurpose = 'apply' | 'followup' | 'reply';
export const MAIL_PURPOSES: readonly MailPurpose[] = ['apply', 'followup', 'reply'];

/**
 * 还不能发的原因（主按钮据此变化，不写成说明文字）：
 *  - no_mailbox：还没连邮箱 → 主按钮是「连邮箱」；
 *  - availability：实习岗位还没说每周几天 / 几个月 / 何时到岗 → 预览顶上点选；
 *  - bad_recipient：收件人不像邮箱，或就是他自己的邮箱 → 收件人一格标红；
 *  - unresolved：标题 / 正文里还有填不上的资料（如没填手机号）→ 那一处标出来。
 */
export type MailBlocker = 'no_mailbox' | 'availability' | 'bad_recipient' | 'unresolved';
export const MAIL_BLOCKERS: readonly MailBlocker[] = ['no_mailbox', 'availability', 'bad_recipient', 'unresolved'];

/** AskView.mail：等你条上这件事是「发邮件前过目」。只有计数和用途，没有邮件内容。 */
export interface AskMail {
  purpose: MailPurpose;
  /** 这件事里每封邮件的 send_mail 动作 id（和 sources 里的 action 一一对应）。 */
  action_ids: string[];
  /** 上一封被退回了：改好收件人重发（主按钮「改好了，重发」）。 */
  bounced?: boolean;
}

/**
 * AskView.mail_failed：等你条上 kind 为 failed 的那件是邮件的失败（不是网申没填成）。
 *  - draft：没写成 → 主按钮「再写一次」（放回队列重写）；
 *  - send：没发出去 → 主按钮「再发一次」（放回待发，他在预览里再点发出——发送永远过人）；
 *    reauth 为 true 时是邮箱授权失效 → 主按钮「重新连邮箱」，连上后再放回待发。
 * 邮件失败没有「我自己来」（那是去浏览器里接手网申）。
 */
export interface AskMailFailed {
  stage: 'draft' | 'send';
  reauth: boolean;
}

/** 实习到岗信息（存基本资料，问一次）。null = 还没说。 */
export interface InternAvailability {
  /** 每周能到几天，如「4」。 */
  days_per_week: string | null;
  /** 能连续实习几个月，如「6」。 */
  months: string | null;
  /** 最早到岗，如「随时」「两周内」「2026-12-01」。 */
  start: string | null;
}
/** 预览顶上给他点的选项（也能自己填）。 */
export const INTERN_DAYS_OPTIONS = ['3', '4', '5'] as const;
export const INTERN_MONTHS_OPTIONS = ['3', '4', '6'] as const;
export const INTERN_START_OPTIONS = ['随时', '一周内', '两周内', '下个月'] as const;

export interface MailAttachmentView {
  /** 对方收到的文件名。 */
  filename: string;
  resume_id: string | null;
  /** 给他看的简历名（「产品方向主简历」）。 */
  resume_label: string;
  /** 按这个岗位改了几处；null = 用的主简历，没定制。 */
  tailored_changes: number | null;
}

/** 一封待发邮件的完整预览（明文，只走专用接口）。 */
export interface MailDraftView {
  action_id: string;
  application_id: string | null;
  job_id: string | null;
  purpose: MailPurpose;
  company: string;
  role: string;
  /** 标了星的目标岗位。 */
  target: boolean;
  to: string;
  cc: string | null;
  subject: string;
  body: string;
  /** 从哪个邮箱发；null = 还没连邮箱。 */
  from: { account_id: string; address: string } | null;
  /** 连了不止一个邮箱时可换。 */
  accounts: Array<{ account_id: string; address: string }>;
  attachments: MailAttachmentView[];
  /** 可换的简历（这个岗位的定制版 + 各份主简历）。 */
  resume_options: Array<{ id: string; label: string }>;
  blockers: MailBlocker[];
  /** 只有实习岗位的投递邮件才有；其余为 null（不问）。 */
  availability: InternAvailability | null;
  /** 跟进 / 回复：接在哪封信下面。 */
  thread: { subject: string; sent_at: string } | null;
  /** 回复类：对方来的那封（预览里放在标题上方给他对照）。 */
  incoming?: MailIncoming | null;
}

/** 对方来的一封信（给人看，明文边界同正文）。 */
export interface MailIncoming {
  from: string;
  text: string;
  received_at: string;
}

/** 一份申请的邮件往来里的一行。 */
export interface MailThreadItem {
  id: string;
  /** out = 我们发出的；in = 对方来的；pending = 写好了等他点发出的。 */
  direction: 'out' | 'in' | 'pending';
  /** 发出的 / 待发的才有用途。 */
  purpose: MailPurpose | null;
  /** 对方的地址：发出时是收件人，来信时是发件人。 */
  counterpart: string;
  subject: string;
  body: string;
  attachments: string[];
  /** 发出 / 收到的时间；待发的是写好的时间。 */
  at: string;
  /** 待发的：对应的 send_mail 动作（点了打开卡组定位到它）。 */
  action_id: string | null;
  /** 来信的种类（自动回复、面试邀请…），没有归类为 null。 */
  kind: string | null;
}

/** GET /api/career/mail-apply/thread?application_id= → { thread: MailThreadView } */
export interface MailThreadView {
  application_id: string;
  company: string;
  role: string;
  /** 按时间从早到晚。 */
  items: MailThreadItem[];
}

/** 改一封：只传要改的。改完服务端重新算 blockers，返回新的预览。 */
export interface MailDraftPatch {
  to?: string;
  subject?: string;
  body?: string;
  /** 换一份简历当附件（重新冻结）。 */
  resume_id?: string;
  account_id?: string;
}

/**
 * 接口（都在 Global 与 Session 路由上）：
 *  GET  /api/career/mail-apply/drafts?ids=a,b        → { drafts: MailDraftView[] }
 *  POST /api/career/mail-apply/drafts/:actionId       ← MailDraftPatch → { draft: MailDraftView }
 *  POST /api/career/mail-apply/availability           ← InternAvailability → { drafts: MailDraftView[] }（存资料，并把所有待发邮件的标题和到岗那句重排）
 * 发出 / 不投：沿用 POST /api/career/actions/review（approved = 立即发；rejected + drop = 这家不投了）。
 */
export const MAIL_APPLY_API = {
  drafts: '/api/career/mail-apply/drafts',
  draft: (actionId: string) => `/api/career/mail-apply/drafts/${encodeURIComponent(actionId)}`,
  availability: '/api/career/mail-apply/availability',
  thread: (applicationId: string) => `/api/career/mail-apply/thread?application_id=${encodeURIComponent(applicationId)}`,
} as const;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isPurpose = (v: unknown): v is MailPurpose => isStr(v) && (MAIL_PURPOSES as readonly string[]).includes(v);

export function isAskMail(v: unknown): v is AskMail {
  return isDict(v) && isPurpose(v.purpose) && Array.isArray(v.action_ids) && v.action_ids.every(isStr)
    && (v.bounced === undefined || typeof v.bounced === 'boolean');
}

export function isAskMailFailed(v: unknown): v is AskMailFailed {
  return isDict(v) && (v.stage === 'draft' || v.stage === 'send') && typeof v.reauth === 'boolean';
}

const isIncoming = (v: unknown): v is MailIncoming => isDict(v) && isStr(v.from) && isStr(v.text) && isStr(v.received_at);
const THREAD_DIRECTIONS: readonly string[] = ['out', 'in', 'pending'];
const isThreadItem = (v: unknown): v is MailThreadItem =>
  isDict(v) && isStr(v.id) && isStr(v.direction) && THREAD_DIRECTIONS.includes(v.direction)
  && (v.purpose === null || isPurpose(v.purpose)) && isStr(v.counterpart) && isStr(v.subject) && isStr(v.body)
  && Array.isArray(v.attachments) && v.attachments.every(isStr) && isStr(v.at) && strOrNull(v.action_id) && strOrNull(v.kind);

export function isMailThreadView(v: unknown): v is MailThreadView {
  return isDict(v) && isStr(v.application_id) && isStr(v.company) && isStr(v.role) && Array.isArray(v.items) && v.items.every(isThreadItem);
}

const isAccount = (v: unknown): v is { account_id: string; address: string } => isDict(v) && isStr(v.account_id) && isStr(v.address);
const isAttachment = (v: unknown): v is MailAttachmentView =>
  isDict(v) && isStr(v.filename) && strOrNull(v.resume_id) && isStr(v.resume_label) && (v.tailored_changes === null || typeof v.tailored_changes === 'number');
const isAvailability = (v: unknown): v is InternAvailability => isDict(v) && strOrNull(v.days_per_week) && strOrNull(v.months) && strOrNull(v.start);

/** 跨边界校验：形状不对就不是一封能给人看的邮件。 */
export function isMailDraftView(v: unknown): v is MailDraftView {
  return isDict(v) && isStr(v.action_id) && strOrNull(v.application_id) && strOrNull(v.job_id) && isPurpose(v.purpose)
    && isStr(v.company) && isStr(v.role) && typeof v.target === 'boolean'
    && isStr(v.to) && strOrNull(v.cc) && isStr(v.subject) && isStr(v.body)
    && (v.from === null || isAccount(v.from)) && Array.isArray(v.accounts) && v.accounts.every(isAccount)
    && Array.isArray(v.attachments) && v.attachments.every(isAttachment)
    && Array.isArray(v.resume_options) && v.resume_options.every(o => isDict(o) && isStr(o.id) && isStr(o.label))
    && Array.isArray(v.blockers) && v.blockers.every(b => isStr(b) && (MAIL_BLOCKERS as readonly string[]).includes(b))
    && (v.availability === null || isAvailability(v.availability))
    && (v.thread === null || (isDict(v.thread) && isStr(v.thread.subject) && isStr(v.thread.sent_at)))
    && (v.incoming === undefined || v.incoming === null || isIncoming(v.incoming));
}
