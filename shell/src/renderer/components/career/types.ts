/**
 * 求职领域数据结构（镜像 packages/core/src/types.ts，前端只读副本）。
 * 字段以 core 为准；这里不引入 workspace 依赖，避免 renderer 打包跨包。
 */

export type ApplicationStage =
  | 'evaluated' | 'ready' | 'approved' | 'applied' | 'responded' | 'interview' | 'offer'
  | 'rejected' | 'discarded' | 'skip' | 'hired' | 'blocked' | 'needs_user' | 'pending';

export type ActionKind = 'fill_form' | 'submit' | 'send_greeting' | 'upload' | 'answer_open_q' | 'collect' | 'research';
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
}
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
}
export interface LiveSnapshot {
  productSessionId: string | null;
  browser: { hasBrowser: boolean; control: 'agent' | 'human' | 'none'; reason: string | null; url?: string; title?: string; channel: string };
  batch: BatchState | null;
  openHandoffs: number;
}
export interface LiveFrame { type: 'frame'; data: string; width: number; height: number; ts: number; url?: string }
export type LiveStreamEvent = ({ type: 'snapshot'; ts: number } & LiveSnapshot) | LiveFrame | { type: 'heartbeat'; ts: number } | { type: 'frame-error' | 'error'; error: string } | ({ type: string; ts?: number } & Record<string, unknown>);

/** 页面 → Chat Tab：请求执行接管动作（Session 路由）。Chat Tab 处理后回发 career:takeover-handled。 */
export interface CareerTakeoverActionRequest {
  requestId: string; runId: string; action: 'take' | 'handback'; resumedFromStep?: string;
}
