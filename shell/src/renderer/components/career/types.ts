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
  /** 谁批准的：user / auto（auto 模式）/ learned（自学习免审）/ system */
  approved_by?: string | null; packet_id?: string | null;
}
/** 填后检查的审阅清单（submit 动作 payload.review.rows）。 */
export type SubmitReviewStatus = 'ok' | 'empty' | 'mismatch' | 'needs_user' | 'draft' | 'site_error' | 'upload_unconfirmed';
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
}
export interface CareerTakeoverEvent {
  sessionId?: string | null; runId: string;
  state: 'running' | 'paused' | 'human_active' | 'resuming';
  reason?: string; url?: string; message?: string;
}
export interface CareerReviewEvent {
  sessionId?: string | null; actionIds: string[]; kind: string; summary: string;
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
  phase?: 'picking' | 'driving' | 'waiting_user' | 'waiting_control' | 'pacing' | 'rate_locked' | 'daily_cap';
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
}
/** 页面请求选文件（系统选文件框被拦下，改在产品里选）。 */
export interface LiveFileChooser { id: string; sessionId: string; multiple: boolean; accept: string | null; url: string; ts: number }
export interface LiveFileChooserEvent extends Partial<LiveFileChooser> { id: string; state: 'open' | 'done' | 'cancelled' | 'expired'; count?: number; names?: string[] }
export interface LiveFrame { type: 'frame'; data: string; width: number; height: number; ts: number; url?: string }
export type LiveStreamEvent = ({ type: 'snapshot'; ts: number } & LiveSnapshot) | LiveFrame | { type: 'heartbeat'; ts: number } | { type: 'frame-error' | 'error'; error: string } | ({ type: string; ts?: number } & Record<string, unknown>);

// ---------- 对话内流程卡片（SSE career:card；对话是主场，卡片把"要用户动手的一步"就地解决） ----------
export type CareerCardKind = 'vault_missing' | 'needs_user' | 'drafts' | 'claims_confirm' | 'resume_diff' | 'site_login' | 'mail_bind' | 'search_setup';
/** 模型 Key（必需）/ 搜索 Key（建议）的配置状态；source=build 表示来自启动环境变量或打包常量。 */
export interface CareerSetupStatus {
  llm: { configured: boolean; source: 'settings' | 'build' | 'none' };
  search: { configured: boolean; source: 'settings' | 'build' | 'none'; provider: 'bocha' | 'tavily' | 'serper' | null };
}
export type CareerCardState = 'pending' | 'completed' | 'dismissed';
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
}
export type DeadlineKind = 'assessment' | 'written_test' | 'interview' | 'application_deadline' | 'offer_reply' | 'referral_expiry' | 'other';
export interface Deadline {
  id: string; kind: DeadlineKind; title: string; due_at: string; application_id: string | null; job_id: string | null;
  interview_id: string | null; offer_id: string | null; source: string; status: 'open' | 'done' | 'missed' | 'cancelled';
  url: string | null; note: string | null; created_at: string; updated_at: string;
}
export interface DossierNote { id: string; application_id: string; kind: 'note' | 'said' | 'heard' | 'contact' | 'referral' | 'mail'; round: string | null; content: string; created_at: string }
export type MaterialKind = 'open_question' | 'project_story' | 'self_intro' | 'why_company' | 'why_role' | 'strength_weakness' | 'career_plan' | 'other';
export interface Material {
  id: string; kind: MaterialKind; title: string; question_key: string | null; content: string; length_variant: string | null;
  claim_ids_json: string; tags_json: string; company_scope: string | null; confirmed: number; created_at: string; updated_at: string;
}
export interface MaterialUse { id: string; material_id: string | null; application_id: string | null; job_id: string | null; company_name: string | null; context: string; content_snapshot: string; used_at: string }
export interface WeeklyReview { id: string; week_start: string; funnel_json: string; insights_json: string; suggestions_json: string; small_action: string | null; created_at: string }
export interface MailAccount {
  id: string; provider: 'qq' | '163' | '126' | 'gmail' | 'outlook' | 'imap'; address: string; display_name: string | null;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; status: 'unverified' | 'ok' | 'auth_failed' | 'error';
  last_sync_at: string | null; last_uid: number; last_error: string | null; created_at: string; updated_at: string;
}
export interface MailPreset { provider: string; label: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; help: string }
export interface MailMessage {
  id: string; account_id: string; uid: number | null; message_id: string | null; in_reply_to: string | null; direction: 'in' | 'out';
  from_addr: string | null; to_addr: string | null; subject: string | null; snippet: string | null; body_text: string | null; received_at: string | null;
  relevance: 'unknown' | 'job' | 'ignored'; kind: InboxKind | null; inbox_item_id: string | null; application_id: string | null; action_id: string | null; created_at: string;
}
export type TodayItemKind = 'deadline' | 'review' | 'handoff' | 'stale' | 'inbox' | 'interview_today' | 'followup';
export interface TodayItem { kind: TodayItemKind; priority: number; title: string; detail?: string; due_at?: string | null; ref: { type: string; id: string }; suggest?: string }
/** 「今天做过」一条：任务进展 / 投递阶段变化 / 动作执行。 */
export interface ActivityEntry { id: string; at: string; kind: 'task' | 'stage' | 'action'; status: string; title: string; detail: string | null }
export interface TodayQueue { items: TodayItem[]; waiting: { count: number; by_stage: Array<{ stage: string; n: number }> }; inbox_new: number; pending_review: number }
export interface OnboardingChecklist { has_experience: boolean; has_confirmed_claim: boolean; has_master_resume: boolean; has_mail_account: boolean; has_job: boolean; has_application: boolean; has_material: boolean }
export interface DossierSummary {
  application_id: string; job_id: string; company_name: string | null; title: string; stage: ApplicationStage; updated_at: string;
  days_since_update: number; next_deadline: Deadline | null; interview_count: number; resume_tailored_id: string | null; closed: boolean;
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
export interface IntakeResult {
  item: InboxItem; triage: { kind?: string; summary?: string; urgency?: string } | null;
  created: { job_id?: string; application_id?: string; interview_id?: string; offer_id?: string; deadline_ids: string[]; closed_application_id?: string };
  focus: CareerFocusEvent; summary: string;
}
/** 工具 / 路由完成后让面板跳到对应对象。 */
export interface CareerFocusEvent { sessionId?: string | null; surface: 'today' | 'inbox' | 'dossier' | 'material' | 'review' | 'guide'; id?: string | null; application_id?: string | null; job_id?: string | null; note?: string }
/** 面板 → 对话：把一句带对象上下文的话真的发进对话。 */
export interface CareerChatSuggestEvent { text: string; context?: { surface?: string; refs?: Record<string, string | null | undefined>; note?: string }; mode?: 'send' | 'prefill' }

// ===== 岗位汇总表 =====
export type EmploymentType = 'campus' | 'intern' | 'social' | 'unknown';
export interface JobPrefs { cohort?: string | null; degree?: string | null; cities?: string[]; employment_types?: EmploymentType[]; keywords?: string[] }
export interface JobHardCheck { rule: string; label: string; ok: boolean | null; detail: string }
export interface JobRequirementMatch { requirement: string; weight: number; status: 'covered' | 'missing'; terms: string[]; evidence?: { id: string; kind: 'claim' | 'resume'; text: string; label?: string } }
export interface JobMatchResult { score: number; hard_ok: boolean; hard: JobHardCheck[]; requirements: JobRequirementMatch[]; covered: number; total: number; summary: string; computed_at: string }
export interface JobBoardRow {
  job: Job & { job_key?: string | null; employment_type?: EmploymentType; cohort?: string | null; source_status?: string };
  match: JobMatchResult | null;
  application: { id: string; stage: ApplicationStage; next_action: string | null; updated_at: string } | null;
}
export interface JobBoardFilter { q?: string; employment_type?: string; city?: string; cohort?: string; open_only?: boolean; fits_only?: boolean; progress?: 'none' | 'active' | 'done'; sort?: 'match' | 'deadline' | 'updated' }
