import type { ApplicationStage, ActionKind, ActionStatus, TaskStatus, HandoffReason, InboxSource, InboxKind, InboxStatus, DeadlineKind, DeadlineStatus, DossierNoteKind, MaterialKind, MailProvider } from './states.js'

export interface Experience { id: string; title: string; role: string | null; org: string | null; start_date: string | null; end_date: string | null; type: string; summary: string | null; redacted: number; created_at: string; updated_at: string }
export interface Claim { id: string; experience_id: string; text: string; attribution: 'self' | 'team' | 'unknown'; result_metric: string | null; status: 'verified' | 'pending' | 'user_confirmed'; created_from: string; created_at: string; updated_at: string }
export interface Evidence { id: string; claim_id: string; kind: string; locator: string; excerpt: string | null; strength: 'strong' | 'mid' | 'weak'; captured_at: string }

export interface ResumeMaster { id: string; name: string; direction: string | null; schema_json: string; created_at: string; updated_at: string }
export interface ResumeTailored { id: string; master_id: string; job_id: string | null; schema_json: string; strength: 'nudge' | 'keywords' | 'full'; diff_confirmed_at: string | null; export_pdf: string | null; export_docx: string | null; export_png: string | null; created_at: string; updated_at: string }

export interface Company { id: string; legal_name: string | null; brand_names: string; dd_report_json: string | null; traffic_light: string | null; manual_checks: string; updated_at: string }
export interface Job { id: string; source_platform: string; source_job_id: string | null; url: string | null; company_id: string | null; company_name: string | null; title: string; location: string | null; salary: string | null; jd_raw: string | null; jd_parsed_json: string | null; prefilter_json: string | null; score_json: string | null; deadline: string | null; deadline_verified_at: string | null; job_key: string | null; remote_id: string | null; employment_type?: string; cohort?: string | null; source_version?: number | null; source_status?: string; match_json?: string | null; match_score?: number | null; created_at: string; updated_at: string }

export interface Application { id: string; job_id: string; resume_tailored_id: string | null; stage: ApplicationStage; next_action: string | null; next_action_due: string | null; blocker_reason: string | null; retry_strategy: string | null; submission_evidence: string | null; answers_used_json: string; page_url: string | null; packet_id: string | null; created_at: string; updated_at: string }
export interface ActionQueueItem { id: string; application_id: string | null; kind: ActionKind; payload_json: string; status: ActionStatus; result_json: string | null; reviewed_at: string | null; content_hash: string | null; approved_hash: string | null; approved_by: string | null; packet_id: string | null; created_at: string; updated_at: string }
/** 投递材料包：批准时冻结的简历快照、文件与 JD 原文（不可变）。 */
export interface ApplicationPacket { id: string; application_id: string | null; job_id: string | null; job_key: string | null; resume_id: string | null; resume_kind: string | null; resume_snapshot_id: string | null; resume_sha256: string | null; resume_pdf_path: string | null; resume_pdf_sha256: string | null; jd_snapshot_json: string; answers_json: string; created_at: string }
export interface Handoff { id: string; action_id: string | null; task_id: string | null; reason: HandoffReason; message: string | null; paused_at: string; resumed_at: string | null; resumed_from_step: string | null }

export interface Task { id: string; title: string; kind: string; status: TaskStatus; progress: number; step: string | null; session_id: string | null; payload_json: string; result_json: string | null; usage_json: string; created_at: string; updated_at: string }
export interface Session { id: string; title: string | null; created_at: string; updated_at: string }
export interface Message { id: string; session_id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content_json: string; created_at: string }

export interface Interview { id: string; application_id: string | null; company_name: string | null; title: string | null; round: string; date: string | null; interviewer_role_guess: string | null; transcript: string | null; tags_json: string; retro_json: string | null; result: string; result_source: string; created_at: string; updated_at: string }
export interface Offer { id: string; application_id: string | null; company_name: string | null; title: string | null; comp_json: string; location: string | null; content_match: string | null; risk_notes: string | null; deadline: string | null; created_at: string; updated_at: string }

/** JD 解析结果（九类分析 + 关键词三分类），各技能共用。 */
export interface JdParsed {
  company?: string; title?: string; location?: string[]; degree?: string; cohort?: string
  hard_requirements: string[]
  responsibilities: string[]
  nice_to_have: string[]
  keywords: { covered: string[]; diggable: string[]; missing: string[] }
  deadline?: string
  notes?: string[]
}

// ===== 五个面 =====
export interface InboxItem { id: string; source: InboxSource; raw_text: string; kind: InboxKind | null; status: InboxStatus; parsed_json: string | null; linked_type: string | null; linked_id: string | null; mail_message_id: string | null; note: string | null; created_at: string; processed_at: string | null }
export interface Deadline { id: string; kind: DeadlineKind; title: string; due_at: string; application_id: string | null; job_id: string | null; interview_id: string | null; offer_id: string | null; source: string; status: DeadlineStatus; url: string | null; note: string | null; created_at: string; updated_at: string }
export interface DossierNote { id: string; application_id: string; kind: DossierNoteKind; round: string | null; content: string; created_at: string }
export interface Material { id: string; kind: MaterialKind; title: string; question_key: string | null; content: string; length_variant: string | null; claim_ids_json: string; tags_json: string; company_scope: string | null; confirmed: number; created_at: string; updated_at: string }
export interface MaterialUse { id: string; material_id: string | null; application_id: string | null; job_id: string | null; company_name: string | null; context: string; content_snapshot: string; used_at: string }
export interface WeeklyReview { id: string; week_start: string; funnel_json: string; insights_json: string; suggestions_json: string; small_action: string | null; created_at: string }
export interface MailAccount { id: string; provider: MailProvider; address: string; display_name: string | null; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; status: string; last_sync_at: string | null; last_uid: number; last_error: string | null; created_at: string; updated_at: string }
export interface MailMessage { id: string; account_id: string; uid: number | null; message_id: string | null; in_reply_to: string | null; direction: 'in' | 'out'; from_addr: string | null; to_addr: string | null; subject: string | null; snippet: string | null; body_text: string | null; received_at: string | null; relevance: 'unknown' | 'job' | 'ignored'; kind: InboxKind | null; inbox_item_id: string | null; application_id: string | null; action_id: string | null; created_at: string }
