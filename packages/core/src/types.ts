import type { ApplicationStage, ActionKind, ActionStatus, TaskStatus, HandoffReason } from './states.js'

export interface Experience { id: string; title: string; role: string | null; org: string | null; start_date: string | null; end_date: string | null; type: string; summary: string | null; redacted: number; created_at: string; updated_at: string }
export interface Claim { id: string; experience_id: string; text: string; attribution: 'self' | 'team' | 'unknown'; result_metric: string | null; status: 'verified' | 'pending' | 'user_confirmed'; created_from: string; created_at: string; updated_at: string }
export interface Evidence { id: string; claim_id: string; kind: string; locator: string; excerpt: string | null; strength: 'strong' | 'mid' | 'weak'; captured_at: string }

export interface ResumeMaster { id: string; name: string; direction: string | null; schema_json: string; created_at: string; updated_at: string }
export interface ResumeTailored { id: string; master_id: string; job_id: string | null; schema_json: string; strength: 'nudge' | 'keywords' | 'full'; diff_confirmed_at: string | null; export_pdf: string | null; export_docx: string | null; export_png: string | null; created_at: string; updated_at: string }

export interface Company { id: string; legal_name: string | null; brand_names: string; dd_report_json: string | null; traffic_light: string | null; manual_checks: string; updated_at: string }
export interface Job { id: string; source_platform: string; source_job_id: string | null; url: string | null; company_id: string | null; company_name: string | null; title: string; location: string | null; salary: string | null; jd_raw: string | null; jd_parsed_json: string | null; prefilter_json: string | null; score_json: string | null; deadline: string | null; deadline_verified_at: string | null; created_at: string; updated_at: string }

export interface Application { id: string; job_id: string; resume_tailored_id: string | null; stage: ApplicationStage; next_action: string | null; next_action_due: string | null; blocker_reason: string | null; retry_strategy: string | null; submission_evidence: string | null; answers_used_json: string; page_url: string | null; created_at: string; updated_at: string }
export interface ActionQueueItem { id: string; application_id: string | null; kind: ActionKind; payload_json: string; status: ActionStatus; result_json: string | null; reviewed_at: string | null; created_at: string; updated_at: string }
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
