/**
 * 邮件投递（face-mail-apply 2026-11-05）：前后端共用的形状。
 *
 * 邮件投递和网申同构：后台写邮件（draft_mail，对应 fill_form）→ 发前过目（send_mail，对应 submit）。
 * 一封待发的邮件 = 一个 pending_review 的 send_mail 动作；预览、改、发出都按动作 id。
 *
 * 明文边界：整封邮件（收件人、标题、正文、附件名）只经 /api/career/mail-apply/* 给渲染层，
 * 不进 AskView、不进对话卡片数据、不进模型上下文、不进日志。AskView 上只带 AskMail（没有邮件内容）。
 *
 * 发前过目是默认；放权和网申同一套（用户 2026-11-05「默认看预览确认，想全自动也要支持，跟网申一样」）：
 * 「自动投递」总开关开着，或「邮件投递」这一类他盖过章（信任账本 MAIL_TRUST_KEY），写好且不差东西的**投递邮件**直接发出。
 * 目标岗位、跟进、回信、退信重发永远先给他看。
 */

/** 信任账本里「邮件投递」这一类（和一种网申系统并列：做通两封后提议「以后直接发」，他点了才放）。 */
export const MAIL_TRUST_KEY = 'channel:mail';
export const MAIL_TRUST_LABEL = '邮件投递';

/** 单个附件最大多少字节：作品集 PDF 常见几 MB，10MB 以上多半该给链接。 */
export const MAIL_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** 一封邮件全部附件加起来最大多少字节：不少企业邮箱收件上限在 20–25MB，超了会被直接退回。 */
export const MAIL_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/** 能当附件的文件类型（按扩展名）。 */
export const MAIL_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'zip'] as const;

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
  /** 这一个附件的 id（拿掉时用）。 */
  id: string;
  /** resume = 简历（可换一份）；file = 他存过的别的文件（作品集、成绩单…，可拿掉）。 */
  kind: 'resume' | 'file';
  /** 对方收到的文件名。 */
  filename: string;
  resume_id: string | null;
  /** 给他看的名字：简历是简历名（「产品方向主简历」），文件是他存的名字（「作品集」）。 */
  resume_label: string;
  /** 按这个岗位改了几处；null = 用的主简历或不是简历。 */
  tailored_changes: number | null;
}

/** 他存过、能当附件的一个文件（作品集、成绩单、证书…）。存一次，以后每封都能点一下附上。 */
export interface MailFileOption {
  id: string;
  label: string;
}

/** 岗位描述里要、而这封还没带上的东西：预览里用一个可点的小签提示加上，不拦发出。 */
export type MailWanted = 'portfolio' | 'transcript';
export const MAIL_WANTED: readonly MailWanted[] = ['portfolio', 'transcript'];

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
  /** 存过的文件里这封还没附上的（点一下附上）。 */
  file_options: MailFileOption[];
  /** 作品集链接：url 为 null = 资料里还没有；included = 正文里带着「作品集：…」这一行。 */
  portfolio: { url: string | null; included: boolean };
  /** 岗位描述里要、这封还没带上的。 */
  wanted: MailWanted[];
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
  /** 附上一个存过的文件。 */
  add_file_id?: string;
  /** 拿掉一个附件（简历也能拿掉；回信默认就没有）。 */
  remove_attachment_id?: string;
  /** 正文里带不带作品集链接那一行。 */
  include_portfolio?: boolean;
  /** 填 / 改作品集链接：存进基本资料（以后每封都用它），并带进这封。 */
  portfolio_url?: string;
}

/** POST /api/career/mail-apply/files ← 存一个文件；带 action_id 时顺手附到那封上。→ { file, draft } */
export interface MailFileUpload {
  /** 原文件名（带扩展名）。 */
  name: string;
  /** 文件内容 base64（不带 data: 前缀）。 */
  base64: string;
  /** 给他看的名字，如「作品集」；不给就用文件名去掉扩展名。 */
  label?: string;
  action_id?: string;
}

// ---------- 邮件投递工作台（功能市场的一级功能，2026-11-06 用户定） ----------

/**
 * 一份邮件申请现在在这条路的哪一站。一份只在一站，按「最需要他的」优先：
 * waiting（等他点头：待发的投递 / 回信 / 跟进 / 退信重发，以及没写成、没发出去的）
 * > writing（在写）> replied（对方有回音）> sent（已发出、还没回音）> ready（库里写了投递邮箱、还没投）。
 */
export type MailStation = 'ready' | 'writing' | 'waiting' | 'sent' | 'replied';
export const MAIL_STATIONS: readonly MailStation[] = ['ready', 'writing', 'waiting', 'sent', 'replied'];

/** 公司小签要的东西（同 core 的 CompanyMark）。 */
export interface MailCompanyMark { company_id: string | null; name: string; logo?: string; fill?: string }

/** 等他的那一封是哪一种：决定行上的记号和两个按钮。 */
export type MailWaitingKind = 'apply' | 'reply' | 'followup' | 'bounced' | 'failed_draft' | 'failed_send';
export const MAIL_WAITING_KINDS: readonly MailWaitingKind[] = ['apply', 'reply', 'followup', 'bounced', 'failed_draft', 'failed_send'];

/** 工作台上的一行 = 一个岗位 / 一份申请。不带邮件内容（内容走 drafts / thread 接口）。 */
export interface MailBoardRow {
  /** 稳定的行标识：有申请用申请 id，否则用岗位 id。 */
  key: string;
  job_id: string;
  application_id: string | null;
  company: MailCompanyMark;
  role: string;
  city: string | null;
  /** 岗位截止日（YYYY-MM-DD）；没有为 null。 */
  deadline: string | null;
  /** 标了星的目标岗位。 */
  target: boolean;
  station: MailStation;
  /** waiting：是哪一种在等他；其余站为 null。 */
  waiting: MailWaitingKind | null;
  /** waiting 且有一封待发邮件时：那封的 send_mail 动作 id（取预览、发出都用它）。没写成的为 null。 */
  action_id: string | null;
  /** waiting：对应等你条上那件事的 id（重试、打开卡组定位用）。 */
  ask_id: string | null;
  /** 投出那天（ISO）；还没投出为 null。 */
  sent_at: string | null;
  /** replied：最近一封来信的种类（interview_invite / written_test / assessment / offer / rejection / application_received；真人回信为 'reply'）。 */
  reply_kind: string | null;
  reply_at: string | null;
}

/** 只设一次的发信设置。 */
export interface MailSetupView {
  /** 发件邮箱；null = 还没连。 */
  mailbox: { account_id: string; address: string } | null;
  availability: InternAvailability;
  /** 他存过的常用附件（作品集、成绩单…）。 */
  files: MailFileOption[];
  portfolio_url: string | null;
  /** 写好直接发：off = 每封先给他看；delegated = 他给「邮件投递」盖过章；auto = 自动投递总开关开着。 */
  direct_send: 'off' | 'delegated' | 'auto';
  /** 有没有至少一份简历。没有时「可以投」的岗位照样列出，主按钮变成「先放一份简历」（缺省当有）。 */
  has_resume?: boolean;
}

export interface MailBoardView {
  rows: MailBoardRow[];
  setup: MailSetupView;
}

/** 改发信设置：只传要改的。 */
export interface MailSetupPatch {
  portfolio_url?: string;
  /** true = 给「邮件投递」这一类盖章（以后写好直接发）；false = 收回。总开关不在这里改。 */
  direct_send?: boolean;
}

/** 贴一段岗位描述进来：里面得明写投递邮箱。→ { row }（落在 ready 那一站） */
export interface MailJobPaste {
  text: string;
}

/**
 * 接口（都在 Global 与 Session 路由上）：
 *  GET  /api/career/mail-apply/board                  → { board: MailBoardView }
 *  POST /api/career/mail-apply/setup                  ← MailSetupPatch → { setup: MailSetupView }
 *  POST /api/career/mail-apply/jobs                   ← MailJobPaste → { row: MailBoardRow }
 *  开始写：沿用 POST /api/career/jobs/apply（job_ids）。到岗信息、存文件沿用下面两个接口。
 *  GET  /api/career/mail-apply/drafts?ids=a,b        → { drafts: MailDraftView[] }
 *  POST /api/career/mail-apply/drafts/:actionId       ← MailDraftPatch → { draft: MailDraftView }
 *  POST /api/career/mail-apply/availability           ← InternAvailability → { drafts: MailDraftView[] }（存资料，并把所有待发邮件的标题和到岗那句重排）
 * 发出 / 不投：沿用 POST /api/career/actions/review（approved = 立即发；rejected + drop = 这家不投了）。
 */
export const MAIL_APPLY_API = {
  board: '/api/career/mail-apply/board',
  setup: '/api/career/mail-apply/setup',
  jobs: '/api/career/mail-apply/jobs',
  drafts: '/api/career/mail-apply/drafts',
  draft: (actionId: string) => `/api/career/mail-apply/drafts/${encodeURIComponent(actionId)}`,
  availability: '/api/career/mail-apply/availability',
  files: '/api/career/mail-apply/files',
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
  isDict(v) && isStr(v.id) && (v.kind === 'resume' || v.kind === 'file') && isStr(v.filename) && strOrNull(v.resume_id) && isStr(v.resume_label)
  && (v.tailored_changes === null || typeof v.tailored_changes === 'number');
export const isMailFileOption = (v: unknown): v is MailFileOption => isDict(v) && isStr(v.id) && isStr(v.label);
const isPortfolio = (v: unknown): v is MailDraftView['portfolio'] => isDict(v) && strOrNull(v.url) && typeof v.included === 'boolean';
const isAvailability = (v: unknown): v is InternAvailability => isDict(v) && strOrNull(v.days_per_week) && strOrNull(v.months) && strOrNull(v.start);

/** 跨边界校验：形状不对就不是一封能给人看的邮件。 */
export function isMailDraftView(v: unknown): v is MailDraftView {
  return isDict(v) && isStr(v.action_id) && strOrNull(v.application_id) && strOrNull(v.job_id) && isPurpose(v.purpose)
    && isStr(v.company) && isStr(v.role) && typeof v.target === 'boolean'
    && isStr(v.to) && strOrNull(v.cc) && isStr(v.subject) && isStr(v.body)
    && (v.from === null || isAccount(v.from)) && Array.isArray(v.accounts) && v.accounts.every(isAccount)
    && Array.isArray(v.attachments) && v.attachments.every(isAttachment)
    && Array.isArray(v.resume_options) && v.resume_options.every(o => isDict(o) && isStr(o.id) && isStr(o.label))
    && Array.isArray(v.file_options) && v.file_options.every(isMailFileOption) && isPortfolio(v.portfolio)
    && Array.isArray(v.wanted) && v.wanted.every(w => isStr(w) && (MAIL_WANTED as readonly string[]).includes(w))
    && Array.isArray(v.blockers) && v.blockers.every(b => isStr(b) && (MAIL_BLOCKERS as readonly string[]).includes(b))
    && (v.availability === null || isAvailability(v.availability))
    && (v.thread === null || (isDict(v.thread) && isStr(v.thread.subject) && isStr(v.thread.sent_at)))
    && (v.incoming === undefined || v.incoming === null || isIncoming(v.incoming));
}

const isCompanyMark = (v: unknown): v is MailCompanyMark =>
  isDict(v) && strOrNull(v.company_id) && isStr(v.name) && (v.logo === undefined || isStr(v.logo)) && (v.fill === undefined || isStr(v.fill));
const inList = (list: readonly string[], v: unknown): boolean => isStr(v) && list.includes(v);

export function isMailBoardRow(v: unknown): v is MailBoardRow {
  return isDict(v) && isStr(v.key) && isStr(v.job_id) && strOrNull(v.application_id) && isCompanyMark(v.company) && isStr(v.role)
    && strOrNull(v.city) && strOrNull(v.deadline) && typeof v.target === 'boolean' && inList(MAIL_STATIONS, v.station)
    && (v.waiting === null || inList(MAIL_WAITING_KINDS, v.waiting)) && strOrNull(v.action_id) && strOrNull(v.ask_id)
    && strOrNull(v.sent_at) && strOrNull(v.reply_kind) && strOrNull(v.reply_at);
}

const DIRECT_SEND: readonly string[] = ['off', 'delegated', 'auto'];

export function isMailSetupView(v: unknown): v is MailSetupView {
  return isDict(v) && (v.mailbox === null || isAccount(v.mailbox)) && isAvailability(v.availability)
    && Array.isArray(v.files) && v.files.every(isMailFileOption) && strOrNull(v.portfolio_url) && inList(DIRECT_SEND, v.direct_send)
    && (v.has_resume === undefined || typeof v.has_resume === 'boolean');
}

export function isMailBoardView(v: unknown): v is MailBoardView {
  return isDict(v) && Array.isArray(v.rows) && v.rows.every(isMailBoardRow) && isMailSetupView(v.setup);
}
