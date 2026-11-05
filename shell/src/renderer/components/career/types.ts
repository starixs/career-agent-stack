/**
 * 求职领域数据结构（镜像 packages/core/src/types.ts，前端只读副本）。
 * 字段以 core 为准；这里不引入 workspace 依赖，避免 renderer 打包跨包。
 */

export type ApplicationStage =
  | 'evaluated' | 'ready' | 'approved' | 'applied' | 'responded' | 'interview' | 'offer'
  | 'rejected' | 'discarded' | 'skip' | 'hired' | 'blocked' | 'needs_user' | 'pending';

export type ActionKind = 'fill_form' | 'submit' | 'send_greeting' | 'upload' | 'answer_open_q' | 'collect' | 'research' | 'send_mail';
export type ActionStatus = 'pending_review' | 'approved' | 'executing' | 'needs_user' | 'done' | 'failed' | 'rejected';
export type HandoffReason = 'captcha' | 'login' | '2fa' | 'assessment' | 'submit_confirm' | 'missing_info' | 'user_request';
export type BrowserControlState = 'idle' | 'running' | 'paused' | 'human_active' | 'resuming';

export interface Experience {
  id: string; title: string; role: string | null; org: string | null;
  start_date: string | null; end_date: string | null; type: string; summary: string | null;
  redacted: number; created_at: string; updated_at: string;
}
export interface Claim {
  id: string; experience_id: string; text: string;
  attribution: 'self' | 'team' | 'unknown';
  result_metric: string | null;
  status: 'verified' | 'pending' | 'user_confirmed';
  created_from: string; created_at: string; updated_at: string;
}
export interface Evidence {
  id: string; claim_id: string; kind: string; locator: string; excerpt: string | null;
  strength: 'strong' | 'mid' | 'weak'; captured_at: string;
}
export type ClaimNode = Claim & { evidence: Evidence[] };
export type ExperienceNode = Experience & { claims: ClaimNode[] };
/** 说法全部来自口述访谈的经历（和服务端 resume-intake.ts oralExperienceIds 同一判断）。 */
export const isOralExperience = (e: ExperienceNode): boolean => Array.isArray(e.claims) && e.claims.length > 0 && e.claims.every(c => c.created_from === 'interview');

export interface ResumeMaster {
  id: string; name: string; direction: string | null; schema_json: string; created_at: string; updated_at: string;
}
export interface ResumeTailored {
  id: string; master_id: string; job_id: string | null; schema_json: string;
  strength: 'nudge' | 'keywords' | 'full';
  diff_confirmed_at: string | null;
  export_pdf: string | null; export_docx: string | null; export_png: string | null;
  created_at: string; updated_at: string;
}

export interface Company {
  id: string; legal_name: string | null; brand_names: string; dd_report_json: string | null;
  traffic_light: string | null; manual_checks: string; updated_at: string;
}
export interface Job {
  id: string; source_platform: string; source_job_id: string | null; url: string | null;
  company_id: string | null; company_name: string | null; title: string; location: string | null;
  salary: string | null; jd_raw: string | null; jd_parsed_json: string | null; prefilter_json: string | null;
  score_json: string | null; deadline: string | null; deadline_verified_at: string | null;
  created_at: string; updated_at: string;
}
export interface Application {
  id: string; job_id: string; resume_tailored_id: string | null; stage: ApplicationStage;
  next_action: string | null; next_action_due: string | null; blocker_reason: string | null;
  retry_strategy: string | null; submission_evidence: string | null; answers_used_json: string;
  page_url: string | null; created_at: string; updated_at: string;
  /** GET /api/career/applications 会 join job 的这几个字段 */
  title?: string | null; company_name?: string | null; deadline?: string | null;
}
export interface ActionQueueItem {
  id: string; application_id: string | null; kind: ActionKind; payload_json: string; status: ActionStatus;
  result_json: string | null; reviewed_at: string | null; created_at: string; updated_at: string;
  /** 谁批准的：user / auto（auto 模式）/ delegated（他盖章放权的那一类）/ learned（旧版自学习免审，历史数据）/ system */
  approved_by?: string | null; packet_id?: string | null;
}
/** 填后检查的审阅清单（submit 动作 payload.review.rows）。 */
export type SubmitReviewStatus = 'ok' | 'empty' | 'empty_optional' | 'unverified' | 'mismatch' | 'needs_user' | 'draft' | 'site_error' | 'upload_unconfirmed';
export interface SubmitReviewRow { fieldId?: string; label: string; required: boolean; status: SubmitReviewStatus; value?: string; source?: string; reason?: string }
export interface SubmitReviewSummary { rows: SubmitReviewRow[]; attention: number; requiredTotal: number; requiredFilled: number }
export interface ApplySettings { auto_mode: boolean; learn_threshold: number }
export type AnswerStatus = 'active' | 'pinned' | 'archived';
export interface AnswerBankEntry { id: string; question_key: string; question_text: string; answer: string; high_impact: number; confirmed: number; status: AnswerStatus; sensitivity: 'normal' | 'personal' | 'self_id' | 'excluded'; source: string; use_count: number; last_used_at: string | null; updated_at: string }
export interface Handoff {
  id: string; action_id: string | null; task_id: string | null; reason: HandoffReason; message: string | null;
  paused_at: string; resumed_at: string | null; resumed_from_step: string | null;
}
export interface Board {
  due: Array<Application & { title: string; company_name: string | null; deadline: string | null }>;
  blocked: Array<Application & { title: string; company_name: string | null }>;
  funnel: Array<{ stage: string; n: number }>;
  pendingReview: number;
}

export interface Interview {
  id: string; application_id: string | null; company_name: string | null; title: string | null;
  round: string; date: string | null; interviewer_role_guess: string | null; transcript: string | null;
  tags_json: string; retro_json: string | null; result: string; result_source: string;
  created_at: string; updated_at: string;
}
/** 用户自己录的面试录音：上传后等语音识别转写，转好了再复盘。 */
export interface InterviewRecording {
  id: string; interview_id: string; name: string; mime: string | null; size: number;
  status: 'awaiting_asr' | 'transcribed' | 'failed'; uploaded_at: string; error?: string;
}
export interface MockInterview {
  id: string; job_id: string | null; resume_tailored_id: string | null; mode: string;
  company_type: string | null; round: string | null; turns_json: string; report_json: string | null;
  created_at: string; updated_at: string;
}
/** 笔试练习：题目 / 作答 / 点评都是 JSON 数组，按题号（index 从 0 起）对应。 */
export interface ExamPractice {
  id: string; title: string; company_name: string | null; job_id: string | null; kind: string | null;
  questions_json: string; answers_json: string; review_json: string; summary: string | null;
  status: 'answering' | 'reviewed'; created_at: string; updated_at: string;
}
/** 评估过的岗位（GET /api/career/job-evaluations）：认得出是哪个岗位，加上 job-evaluate 的整份输出。 */
export interface JobEvaluation {
  job_id: string; company_name: string | null; title: string; url: string | null;
  score_json: string; prefilter_json: string | null; updated_at: string;
}
export interface ProbePrediction {
  id: string; resume_tailored_id: string | null; claim_id: string | null; statement: string;
  target_type: string; expected_chain_json: string; risk: string; created_at: string;
}
export interface Direction {
  id: string; name: string; status: 'candidate' | 'tentative' | 'chosen' | 'dropped';
  rationale_json: string | null; created_at: string; updated_at: string;
}
export interface GapPlan {
  id: string; job_id: string | null; direction_id: string | null; gaps_json: string; actions_json: string; created_at: string;
}
export interface Offer {
  id: string; application_id: string | null; company_name: string | null; title: string | null;
  comp_json: string; location: string | null; content_match: string | null; risk_notes: string | null;
  deadline: string | null; created_at: string; updated_at: string;
}

// ===== SSE 事件载荷 =====
export interface CareerProgressEvent {
  sessionId?: string | null; taskId?: string; runId?: string; phase: string; message: string; progress?: number;
  /** 网申浏览器卡片的步骤条与对象（打开网页 → 登录 → 填表 → 传简历 → 提交）——待后端。 */
  steps?: Array<{ label: string; state: 'done' | 'current' | 'todo' | 'failed' }>;
  company?: string; job_title?: string;
  /** 批量网申：这条进度属于哪份网申（现场窗按它切到那一家的页面）。 */
  application_id?: string;
}
export interface CareerTakeoverEvent {
  sessionId?: string | null; runId: string;
  state: 'running' | 'paused' | 'human_active' | 'resuming';
  reason?: string; url?: string; message?: string;
}
export interface CareerReviewEvent {
  sessionId?: string | null; actionIds: string[]; kind: string; summary: string;
  /** 产生它的工具调用（对话里的工具才有；后台批量 / 提交执行器没有）。 */
  toolUseId?: string | null;
  /** 卡片里要展示的内容（提交前的审阅清单等）。 */
  data?: Record<string, unknown>;
}
export interface CareerDataChangedEvent {
  sessionId?: string | null; tables: string[];
}
// ---------- 私密信息库（镜像 packages/core/src/vault.ts，前端永远只拿元数据） ----------
export type VaultScope = 'profile' | 'site' | 'experience';
export interface VaultItemMeta {
  id: string; scope: VaultScope; ref_id: string; field: string; label: string | null; preview: string | null;
  sensitive: boolean; policy: { autofill?: boolean }; created_at: string; updated_at: string;
}
export interface VaultProfileFieldDef { field: string; label: string; sensitive: boolean; group: 'identity' | 'contact' | 'education' | 'preference'; hint?: string }
export interface VaultStatus {
  profile: { filled: Array<{ field: string; label: string; preview: string; sensitive: boolean }>; missing: Array<{ field: string; label: string }> };
  sites: Array<{ host: string; label: string | null; hasUsername: boolean; hasPassword: boolean; autofill: boolean }>;
  experiences: Array<{ experience_id: string; fields: Array<{ field: string; label: string | null; placeholder: string }> }>;
}
export interface VaultOverview { status: VaultStatus; items: VaultItemMeta[]; profileFields: VaultProfileFieldDef[]; siteFields: string[] }
export interface VaultAccessLogRow { id: string; item_id: string | null; actor: string; purpose: string | null; at: string }

// ---------- 浏览器现场 / 批量投递（Global 路由 /api/career/live、/api/career/batch） ----------
export type BatchStatus = 'idle' | 'running' | 'paused' | 'stopped';
export interface BatchState {
  status: BatchStatus; startedAt?: string; updatedAt: string; currentActionId?: string; currentTitle?: string;
  phase?: 'picking' | 'driving' | 'waiting_user' | 'waiting_control' | 'pacing' | 'rate_locked' | 'browser_down';
  message?: string; done: number; failed: number; handoffs: number; queued: number; todayCount: number; lastError?: string;
  /** 正在并行填写的网申（不同网站各一份）。 */
  running?: Array<{ actionId: string; title: string; host: string }>; concurrency?: number;
}
export interface LiveSnapshot {
  productSessionId: string | null;
  browser: { hasBrowser: boolean; control: 'agent' | 'human' | 'none'; reason: string | null; url?: string; title?: string; channel: string; embedded?: boolean; windowRevealed?: boolean };
  batch: BatchState | null;
  openHandoffs: number;
  fileChooser?: LiveFileChooser | null;
  /** 登录之旅：第几家（从 0 数）/ 共几家。 */
  journey?: { index: number; total: number } | null;
  /** 助理正在等你处理（browser_wait_user）：交还时它自己会接着办。 */
  waitingUser?: boolean;
  /** 登录之旅里这一家的短信码代办状态（Global login-journey）。 */
  sms?: { status: 'sent' | 'captcha' | 'mail_captcha' | 'no_sms' | 'registering' | 'registered' | 'image_code' | 'checking' | 'logged_in'; detail?: string; image?: string; site?: string } | null;
}
/** 页面请求选文件（系统选文件框被拦下，改在产品里选）。 */
export interface LiveFileChooser { id: string; sessionId: string; multiple: boolean; accept: string | null; url: string; ts: number }
export interface LiveFileChooserEvent extends Partial<LiveFileChooser> { id: string; state: 'open' | 'done' | 'cancelled' | 'expired'; count?: number; names?: string[] }
export interface LiveFrame { type: 'frame'; data: string; width: number; height: number; ts: number; url?: string; source?: 'screencast' | 'snapshot' }
/** 画面状态（Global 推送）：waiting 还没打开 / connecting 正在接上 / closed 接上后被关掉。 */
export interface LiveFrameStatus { type: 'frame-status'; state: 'waiting' | 'connecting' | 'closed'; message?: string }
/** 状态 → 画面占位文字。 */
export function liveStatusText(ev: LiveFrameStatus): string {
  if (ev.message) return ev.message;
  return ev.state === 'connecting' ? '正在接上浏览器画面…' : ev.state === 'closed' ? '浏览器已关闭' : '浏览器还没有打开';
}
export type LiveStreamEvent = ({ type: 'snapshot'; ts: number } & LiveSnapshot) | LiveFrame | { type: 'heartbeat'; ts: number } | { type: 'frame-error' | 'error'; error: string } | ({ type: string; ts?: number } & Record<string, unknown>);

// ---------- 对话内流程卡片（SSE career:card；对话是主场，卡片把"要用户动手的一步"就地解决） ----------
export type CareerCardKind = 'vault_missing' | 'needs_user' | 'drafts' | 'claims_confirm' | 'resume_intake' | 'tailor_diff' | 'site_login' | 'mail_bind' | 'search_setup' | 'review' | 'apply_gaps' | 'interview_prep' | 'takeover' | 'application' | 'fix' | 'batch_pick';
/** 模型 Key（必需）/ 搜索的配置状态；source=build 表示来自启动环境变量或打包常量。没单独配搜索时用模型 Key 走 DeepSeek 搜索（provider=deepseek）。 */
export interface CareerSetupStatus {
  llm: { configured: boolean; source: 'settings' | 'build' | 'none' };
  search: { configured: boolean; source: 'settings' | 'build' | 'none'; provider: 'bocha' | 'tavily' | 'serper' | 'deepseek' | null };
}
export type CareerCardState = 'pending' | 'completed' | 'dismissed';
/** 让小芽在对话里放一张勾选表：job_ids = 只列这几家（建议条点名的）；pick = all 时默认全勾（一家一个岗）。 */
export interface ProposeBatchOptions { job_ids?: string[]; pick?: 'default' | 'all' }
export interface CareerCard {
  id: string; kind: CareerCardKind; title: string; data: Record<string, unknown>; createdAt: string; sessionId?: string | null;
  /** 锚点：产生它的工具调用；渲染在那条回复下面。为空（后台批量等）时挂在对话底部。 */
  toolUseId?: string | null;
  /** pending 显示完整卡片；completed / dismissed 折叠成一行。 */
  state?: CareerCardState;
}
export interface CareerCardEvent { sessionId?: string | null; card: CareerCard }

/** 页面 → Chat Tab：请求执行接管动作（Session 路由）。Chat Tab 处理后回发 career:takeover-handled。 */
export interface CareerTakeoverActionRequest {
  requestId: string; runId: string; action: 'take' | 'handback'; resumedFromStep?: string;
}

// ===== 五个面：收件箱 / 今日 / 卷宗 / 素材 / 复盘 + 邮箱 =====
export type InboxKind = 'jd' | 'interview_invite' | 'assessment' | 'written_test' | 'rejection' | 'offer' | 'referral' | 'deadline' | 'other';
export interface InboxItem {
  id: string; source: 'paste' | 'mail' | 'file' | 'url' | 'chat'; raw_text: string; kind: InboxKind | null;
  status: 'new' | 'processed' | 'dismissed'; parsed_json: string | null; linked_type: string | null; linked_id: string | null;
  mail_message_id: string | null; note: string | null; created_at: string; processed_at: string | null;
  /** 服务端算的：已归档且它带来的事都处理完了（core.Repos.inboxSettled），通知中心折进「已处理」。 */
  settled?: boolean;
}
export type DeadlineKind = 'assessment' | 'written_test' | 'interview' | 'application_deadline' | 'offer_reply' | 'referral_expiry' | 'other';
export interface Deadline {
  id: string; kind: DeadlineKind; title: string; due_at: string | null; application_id: string | null; job_id: string | null;
  interview_id: string | null; offer_id: string | null; source: string; status: 'open' | 'done' | 'missed' | 'cancelled' | 'skipped';
  url: string | null; note: string | null; created_at: string; updated_at: string;
  /** 过了时间的笔试 / 测评（面试过了时间走复盘，不问）：服务端给出要问的那句（「考了吗？」），答完收进卷宗；不用问时为 null / 缺省。 */
  attendance_question?: string | null;
}
export interface DossierNote { id: string; application_id: string; kind: 'note' | 'said' | 'heard' | 'contact' | 'referral' | 'mail'; round: string | null; content: string; created_at: string }
export type MaterialKind = 'open_question' | 'project_story' | 'self_intro' | 'why_company' | 'why_role' | 'strength_weakness' | 'career_plan' | 'other';
export interface Material {
  id: string; kind: MaterialKind; title: string; question_key: string | null; content: string; length_variant: string | null;
  claim_ids_json: string; tags_json: string; company_scope: string | null; confirmed: number; created_at: string; updated_at: string;
}
export interface MaterialUse { id: string; material_id: string | null; application_id: string | null; job_id: string | null; company_name: string | null; context: string; content_snapshot: string; used_at: string }
export interface MailAccount {
  id: string; provider: 'qq' | '163' | '126' | 'gmail' | 'outlook' | 'imap'; address: string; display_name: string | null;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; status: 'unverified' | 'ok' | 'auth_failed' | 'error';
  last_sync_at: string | null; last_uid: number; last_error: string | null; created_at: string; updated_at: string;
  consecutive_fails?: number; last_ok_at?: string | null; last_check_at?: string | null;
  /** 连接状态投影（服务端 mail/connectors.ts connectionOf 判定，界面只展示）。 */
  connection?: { state: 'active' | 'expired' | 'verifying'; health: 'healthy' | 'degraded' | 'expired' };
}
/** 邮箱连接器目录（服务端 mail/connectors.ts）：引导、字段、官方页面都是数据。 */
export type MailConnectorId = 'qq' | '163' | '126' | 'gmail';
export interface MailConnector {
  id: MailConnectorId; name: string; auth_type: 'credential_form' | 'oauth'; capabilities: Array<'receive' | 'send'>;
  open_url: string; open_label: string; help_url: string | null;
  guide: Array<{ title: string; text: string; path?: string[] }>;
  verify_note: string;
  fields: Array<{ key: 'email' | 'authCode'; type: 'email' | 'secret'; label: string; placeholder: string; helper?: string; length?: number }>;
  /** OAuth 轨（预留）：审核通过、云端开启后为 true。 */
  oauth?: { enabled: boolean };
}
/** 接管简报（服务端 mail/takeover.ts）。 */
export type SeasonId = 'prep' | 'autumn_early' | 'autumn' | 'spring' | 'offer';
export interface TakeoverBriefing {
  report: { account_id: string; address: string; started_at: string; updated_at: string; viewed_at: string | null; mails: number; by_rules: number; by_model: number; unclassified: number; application_ids: string[]; span: { from: string | null; to: string | null } };
  applications: number;
  buckets: Array<{ id: 'applied' | 'interview' | 'offer' | 'closed'; label: string; items: Array<{ application_id: string; company: string | null; title: string; stage: string }> }>;
  needs: Array<{ deadline_id: string; application_id: string | null; kind: string; title: string; due_at: string | null; url: string | null }>;
  season: { id: SeasonId; label: string; basis: string; source: 'user' | 'guess' };
  seasons: Array<{ id: SeasonId; label: string }>;
  unclassified: Array<{ mail_id: string; subject: string | null; from: string | null; received_at: string | null }>;
}
export type MailOauthStart = { ok: true; authorize_url: string; state: string } | { ok: false; error_code: string; message: string };
export type MailConnectErrorCode = 'imap_auth_failed' | 'imap_disabled' | 'provider_blocked' | 'unreachable' | 'duplicate' | 'invalid_input';
export type MailConnectResult =
  | { ok: true; account: MailAccount; smtp_ok: boolean; /** 网申填的是另一个邮箱时给出那个地址：那边的回音这里收不到 */ apply_address_mismatch?: string | null }
  | { ok: false; error_code: MailConnectErrorCode; message: string; account_id?: string };
export interface MailAuditEntry { id: string; actor: 'agent' | 'user' | 'system'; operation: string; status: 'ok' | 'failed'; detail: Record<string, unknown> | null; latency_ms: number | null; created_at: string }
export interface MailAccountDetail { account: MailAccount; usage: { days: number; by_op: Record<string, { ok: number; failed: number }> }; audit: MailAuditEntry[] }
export interface MailPreset { provider: string; label: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; help: string }
export interface MailMessage {
  id: string; account_id: string; uid: number | null; message_id: string | null; in_reply_to: string | null; direction: 'in' | 'out';
  from_addr: string | null; to_addr: string | null; subject: string | null; snippet: string | null; body_text: string | null; received_at: string | null;
  relevance: 'unknown' | 'job' | 'ignored'; kind: InboxKind | null; inbox_item_id: string | null; application_id: string | null; action_id: string | null; created_at: string;
}
export type TodayItemKind = 'deadline' | 'review' | 'handoff' | 'stale' | 'inbox' | 'interview_today' | 'interview_retro' | 'followup' | 'mail_auth';
export interface TodayItem { kind: TodayItemKind; priority: number; title: string; detail?: string; due_at?: string | null; ref: { type: string; id: string }; deadline_id?: string; suggest?: string; ask?: 'attendance' }
/** 「今天做过」一条：任务进展 / 投递阶段变化 / 动作执行。 */
export interface ActivityEntry { id: string; at: string; kind: 'task' | 'stage' | 'action'; status: string; title: string; detail: string | null }
export interface TodayQueue { items: TodayItem[]; waiting: { count: number; by_stage: Array<{ stage: string; n: number }> }; inbox_new: number; pending_review: number }
export interface OnboardingChecklist { has_experience: boolean; has_confirmed_claim: boolean; has_master_resume: boolean; has_mail_account: boolean; has_job: boolean; has_application: boolean; has_material: boolean }
export interface DossierSummary {
  application_id: string; job_id: string; company_name: string | null; title: string; stage: ApplicationStage; updated_at: string;
  days_since_update: number; next_deadline: Deadline | null; interview_count: number; resume_tailored_id: string | null; closed: boolean;
  /** 以下由服务端 dossierSummaries 给出；旧数据可能缺，按缺省处理。 */
  created_at?: string; applied_at?: string | null; reached_stages?: string[]; exam_kinds?: Array<'assessment' | 'written_test'>; job_url?: string | null;
  /** 目标申请：interview = 进过面试（自动）；user = 用户亲手标的；null = 不算。系统不替用户认定。 */
  target?: 'interview' | 'user' | null;
}
export interface Dossier {
  application: Application; job: Job; company: Company | null;
  resume: { kind: 'master' | 'tailored'; id: string; schema: unknown; confirmed: boolean } | null;
  answers_used: unknown; material_uses: MaterialUse[]; notes: DossierNote[]; deadlines: Deadline[];
  interviews: Interview[]; offers: Offer[]; history: Array<{ from_stage: string | null; to_stage: string; note: string | null; created_at: string }>;
  mails: MailMessage[]; actions: ActionQueueItem[]; predictions: ProbePrediction[];
}
export interface FunnelRow { key: string; total: number; applied: number; responded: number; interview: number; offer: number; rejected: number; silent: number }
export interface Funnel { by_category: FunnelRow[]; by_platform: FunnelRow[]; overall: FunnelRow | null }
/** 「我的求职月」看板，结构同 @career/core 的 MonthBoard。四层：投出 → 笔试/测评 → 面试 → Offer。 */
export type LayerCounts = [number, number, number, number];
export interface MonthDay { day: number; sent: number; split: LayerCounts; pending: boolean; companies: { exam: string[]; interview: string[]; offer: string[] } }
export interface MonthBoard {
  month: { key: string; year: number; month: number; days: number; dow1: number; today: number | null; is_current: boolean; prev_key: string | null; next_key: string | null };
  counts: LayerCounts;
  prev: LayerCounts | null;
  history: Array<{ key: string; month: number; counts: LayerCounts }>;
  in_transit: number;
  since_total: number;
  days: MonthDay[];
  exams: Array<{ company: string; kind: 'assessment' | 'written_test'; status: string; due_at: string | null }>;
  interviews: Array<{ company: string; rounds: Array<{ round: string; done: boolean; date: string | null }> }>;
  next_interview: { company: string; round: string; date: string } | null;
  offers: Array<{ company: string; title: string | null; location: string | null; reply_by: string | null }>;
  rhythm: { reply_days: number | null; first_interview_after: number | null };
}
export interface IntakeResult {
  item: InboxItem; triage: { kind?: string; summary?: string; urgency?: string } | null;
  created: { job_id?: string; application_id?: string; interview_id?: string; offer_id?: string; deadline_ids: string[]; closed_application_id?: string };
  focus: CareerFocusEvent; summary: string;
}
/** 工具 / 路由完成后让面板跳到对应对象。 */
export interface CareerFocusEvent {
  sessionId?: string | null; surface: 'today' | 'takeover' | 'inbox' | 'dossier' | 'material' | 'review' | 'guide'; id?: string | null; application_id?: string | null; job_id?: string | null; note?: string;
  /** 投递记录按一组投递筛选（从漏斗、甘特跳过去）；label 说明这组是什么。 */
  filter?: { label: string; application_ids: string[] };
  /** assistant = 小芽在对话里做完事推来的提示：只记下定位，不把用户从对话里带走。 */
  origin?: 'user' | 'assistant';
}
/** 面板 → 对话：把一句带对象上下文的话真的发进对话。 */
export interface CareerChatSuggestEvent { text: string; context?: { surface?: string; refs?: Record<string, string | null | undefined>; note?: string }; mode?: 'send' | 'prefill' }

// ===== 岗位汇总表 =====
export type EmploymentType = 'campus' | 'intern' | 'social' | 'unknown';
/** 框选确认前的计划（服务端 career/batch-apply.ts JobPlan）。 */
export interface JobPlan { ready: string[]; targets: number; skipped: Array<{ job_id: string; reason: string }>; needs_resume: string[]; resumes: Array<{ id: string; name: string }> }
export interface JobPrefs { cohort?: string | null; degree?: string | null; cities?: string[]; employment_types?: EmploymentType[]; keywords?: string[] }
export interface JobHardCheck { rule: string; label: string; ok: boolean | null; detail: string }
export interface JobRequirementMatch { requirement: string; weight: number; status: 'covered' | 'missing'; terms: string[]; evidence?: { id: string; kind: 'claim' | 'resume'; text: string; label?: string } }
export interface JobMatchResult { score: number; hard_ok: boolean; hard: JobHardCheck[]; requirements: JobRequirementMatch[]; covered: number; total: number; summary: string; computed_at: string }
export interface JobBoardRow {
  job: Job & { job_key?: string | null; employment_type?: EmploymentType; cohort?: string | null; source_status?: string };
  match: JobMatchResult | null;
  application: { id: string; stage: ApplicationStage; next_action: string | null; updated_at: string } | null;
  /** 多维表格维度（server job-board.ts boardMeta）：来源数据里有才有。 */
  meta?: JobBoardMeta;
  /** 目标岗位：interview = 进过面试；user = 用户亲手标的；null = 不算。 */
  target?: 'interview' | 'user' | null;
}
export interface JobBoardMeta { batch: string | null; industry: string | null; type_tags: string[] }
export interface JobBoardFilter { q?: string; employment_type?: string; city?: string; cohort?: string; open_only?: boolean; fits_only?: boolean; progress?: 'none' | 'active' | 'done'; sort?: 'match' | 'deadline' | 'updated' }

// ===== 题库 =====
export interface QuestionItem {
  id: string; question_key: string; kind: 'interview' | 'written' | 'assessment'; category: string | null; content: string; reference: string | null; probe_points_json: string; jd_requirement: string | null;
  company_name: string | null; title: string | null; job_id: string | null; source: 'public' | 'seen' | 'generated'; sources_json: string; tags_json: string;
  seen_count: number; attempt_count: number; last_attempt_score: number | null; best_attempt_score: number | null; first_seen_at: string | null; last_seen_at: string | null; updated_at: string;
}
export interface QuestionAttempt { id: string; question_id: string; mode: string; answer_text: string | null; score: number | null; feedback_json: string; resume_id: string | null; job_id: string | null; created_at: string }

// ===== 过机筛 =====
export interface AtsIssue { level: 'error' | 'warn'; code: string; message: string }
export interface AtsReport { ok: boolean; score: number; issues: AtsIssue[]; extracted_chars: number; expected_chars: number; pages: number }

// ===== 经历访谈进度 =====
export interface InterviewProgress {
  rounds: Array<{ key: string; label: string; status: 'todo' | 'in_progress' | 'done' | 'none' }>;
  done: number; next_round: string | null; current_experience_id: string | null; follow_up_questions: string[];
  gaps: { experiences_without_confirmed: Array<{ id: string; title: string }>; claims_without_metric: Array<{ id: string; text: string; experience: string }>; pending_claims: number };
  suggestion: string;
}

/** 绑定账号的抓取状态（与 server/career/accounts.ts 同形）。 */
export interface AccountFetchState {
  status: 'requested' | 'ok' | 'login_expired' | 'failed';
  requested_at: string;
  fetched_at: string | null;
  note: string | null;
}
